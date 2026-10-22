// PCM16LE mono 48 kHz stdio bridge. Only explicitly selected virtual devices.
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <pthread.h>
#include <poll.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>

#define CAP 131072u
typedef struct { int16_t data[CAP]; _Atomic uint64_t read, write; } Ring;
static Ring rx, tx;
static volatile sig_atomic_t stopping;
static _Atomic uint64_t captured, played, dropped, silence;
typedef struct { int capture, playback; } Context;
static void stop(int s) { (void)s; stopping = 1; }
static int push(Ring *r, int16_t value) {
    uint64_t w = atomic_load_explicit(&r->write, memory_order_relaxed);
    if (w - atomic_load_explicit(&r->read, memory_order_acquire) == CAP) return 0;
    r->data[w % CAP] = value;
    atomic_store_explicit(&r->write, w + 1, memory_order_release); return 1;
}
static int pop(Ring *r, int16_t *value) {
    uint64_t n = atomic_load_explicit(&r->read, memory_order_relaxed);
    if (n == atomic_load_explicit(&r->write, memory_order_acquire)) return 0;
    *value = r->data[n % CAP];
    atomic_store_explicit(&r->read, n + 1, memory_order_release); return 1;
}
static OSStatus io(AudioDeviceID d, const AudioTimeStamp *t, const AudioBufferList *in,
    const AudioTimeStamp *it, AudioBufferList *out, const AudioTimeStamp *ot, void *ctx) {
    (void)d; (void)t; (void)it; (void)ot; Context *c = ctx;
    if (c->capture && in) for (UInt32 b = 0; b < in->mNumberBuffers; b++) {
        const AudioBuffer *a = &in->mBuffers[b];
        if (!a->mData || a->mNumberChannels != 1) continue;
        const float *f = a->mData;
        for (UInt32 n = 0; n < a->mDataByteSize / 4; n++) {
            float v = isfinite(f[n]) ? f[n] : 0;
            int16_t s = v >= 1 ? 32767 : v <= -1 ? -32768 : (int16_t)(v * 32768.f);
            if (!push(&rx, s)) atomic_fetch_add(&dropped, 1);
            atomic_fetch_add(&captured, 1);
        }
    }
    if (out) for (UInt32 b = 0; b < out->mNumberBuffers; b++) {
        AudioBuffer *a = &out->mBuffers[b]; if (!a->mData) continue;
        float *f = a->mData;
        for (UInt32 n = 0; n < a->mDataByteSize / 4; n++) {
            int16_t s = 0;
            if (c->playback) {
                if (!pop(&tx, &s)) atomic_fetch_add(&silence, 1);
                atomic_fetch_add(&played, 1);
            }
            f[n] = s / 32768.f;
        }
    }
    return noErr;
}
static int get(AudioDeviceID d, AudioObjectPropertySelector p, AudioObjectPropertyScope scope, void *v, UInt32 *size) {
    AudioObjectPropertyAddress a = {p, scope, kAudioObjectPropertyElementMain};
    return AudioObjectGetPropertyData(d, &a, 0, NULL, size, v) == noErr;
}
static void string(AudioDeviceID d, AudioObjectPropertySelector p, char *v, size_t size) {
    CFStringRef s = NULL; UInt32 len = sizeof(s); v[0] = 0;
    if (get(d,p,kAudioObjectPropertyScopeGlobal,&s,&len) && s) {
        CFStringGetCString(s,v,size,kCFStringEncodingUTF8); CFRelease(s);
    }
}
static void json(const char *s) {
    putchar('"'); for (; *s; s++) { unsigned char c = *s;
        if (c == '"' || c == '\\') { putchar('\\'); putchar(c); }
        else if (c < 32) printf("\\u%04x",c); else putchar(c);
    } putchar('"');
}
static AudioStreamBasicDescription format(AudioDeviceID d, AudioObjectPropertyScope scope) {
    AudioStreamBasicDescription f = {0}; UInt32 len = sizeof(f);
    get(d,kAudioDevicePropertyStreamFormat,scope,&f,&len); return f;
}
static int validate(AudioDeviceID d, AudioObjectPropertyScope scope) {
    UInt32 transport = 0, len = sizeof(transport);
    if (!get(d,kAudioDevicePropertyTransportType,kAudioObjectPropertyScopeGlobal,&transport,&len) ||
        transport != kAudioDeviceTransportTypeVirtual) {
        fprintf(stderr,"Selected device is not verified virtual; refusing audio IO\n"); return 0;
    }
    AudioStreamBasicDescription f = format(d,scope);
    if (f.mFormatID != kAudioFormatLinearPCM || !(f.mFormatFlags & kAudioFormatFlagIsFloat) ||
        (f.mFormatFlags & kAudioFormatFlagIsBigEndian) || f.mBitsPerChannel != 32 ||
        f.mChannelsPerFrame != 1 || f.mSampleRate != 48000 || f.mBytesPerFrame != 4) {
        fprintf(stderr,"Requires Float32 native-endian mono 48000 Hz; got channels=%u rate=%.0f bits=%u\n",
            f.mChannelsPerFrame,f.mSampleRate,f.mBitsPerChannel); return 0;
    } return 1;
}
static void *read_stdin(void *unused) {
    (void)unused; unsigned char bytes[4096]; int pending = -1;
    while (!stopping) {
        struct pollfd p = {STDIN_FILENO,POLLIN,0};
        int ready = poll(&p,1,100); if (ready < 0 && errno == EINTR) continue;
        if (ready <= 0) continue;
        ssize_t count = read(STDIN_FILENO,bytes,sizeof(bytes));
        if (count <= 0) { if (count < 0 && errno == EINTR) continue; stopping = 1; break; }
        for (ssize_t i = 0; i < count && !stopping; i++) {
            if (pending < 0) pending = bytes[i];
            else { int16_t s = (int16_t)(pending | (bytes[i] << 8)); pending = -1;
                while (!stopping && !push(&tx,s)) usleep(2000);
            }
        }
    } return NULL;
}
static void *write_stdout(void *unused) {
    (void)unused; unsigned char bytes[4096];
    while (!stopping) {
        size_t size = 0; int16_t s;
        while (size < sizeof(bytes) && pop(&rx,&s)) { bytes[size++] = s & 255; bytes[size++] = (uint16_t)s >> 8; }
        if (!size) { usleep(2000); continue; }
        size_t offset = 0;
        while (offset < size && !stopping) {
            struct pollfd p = {STDOUT_FILENO,POLLOUT,0}; if (poll(&p,1,100) <= 0) continue;
            ssize_t n = write(STDOUT_FILENO,bytes + offset,size - offset);
            if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
            if (n <= 0) { stopping = 1; break; } offset += n;
        }
    } return NULL;
}
int main(int argc, char **argv) {
    const char *input = NULL, *output = NULL; int list = 0, allow = 0;
    for (int n = 1; n < argc; n++) {
        if (!strcmp(argv[n],"--list")) list = 1;
        else if (!strcmp(argv[n],"--allow-loopback")) allow = 1;
        else if (!strcmp(argv[n],"--input") && n + 1 < argc) input = argv[++n];
        else if (!strcmp(argv[n],"--output") && n + 1 < argc) output = argv[++n];
        else { fprintf(stderr,"Usage: pcm-bridge --list | --input UID --output UID [--allow-loopback]\n"); return 2; }
    }
    if (!list && (!output || (input && !allow && !strcmp(input,output)))) {
        fprintf(stderr,"Explicit output UID required; optional input UID must differ unless --allow-loopback\n"); return 2;
    }
    AudioObjectPropertyAddress a = {kAudioHardwarePropertyDevices,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject,&a,0,NULL,&size)) return 1;
    AudioDeviceID *devices = calloc(size ? size : 1,1); if (!devices) return 1;
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject,&a,0,NULL,&size,devices)) { free(devices); return 1; }
    AudioDeviceID in = 0, out = 0; if (list) putchar('[');
    for (UInt32 n = 0; n < size / sizeof(*devices); n++) {
        char uid[2048], name[2048]; string(devices[n],kAudioDevicePropertyDeviceUID,uid,sizeof(uid));
        string(devices[n],kAudioObjectPropertyName,name,sizeof(name));
        if (input && !strcmp(uid,input)) in = devices[n]; if (output && !strcmp(uid,output)) out = devices[n];
        if (list) {
            AudioStreamBasicDescription fi = format(devices[n],kAudioObjectPropertyScopeInput), fo = format(devices[n],kAudioObjectPropertyScopeOutput);
            UInt32 transport = 0, len = sizeof(transport); get(devices[n],kAudioDevicePropertyTransportType,kAudioObjectPropertyScopeGlobal,&transport,&len);
            if (n) putchar(','); printf("{\"name\":"); json(name); printf(",\"uid\":"); json(uid);
            printf(",\"inputChannels\":%u,\"outputChannels\":%u,\"inputSampleRate\":%.0f,\"outputSampleRate\":%.0f,\"virtual\":%s}",
                fi.mChannelsPerFrame,fo.mChannelsPerFrame,fi.mSampleRate,fo.mSampleRate,transport == kAudioDeviceTransportTypeVirtual ? "true" : "false");
        }
    }
    free(devices); if (list) { puts("]"); return 0; }
    if ((input && !in) || !out) { fprintf(stderr,"Selected device UID not found\n"); return 2; }
    if ((input && !validate(in,kAudioObjectPropertyScopeInput)) || !validate(out,kAudioObjectPropertyScopeOutput)) return 2;
    if (!input) in = out;
    int flags = fcntl(STDOUT_FILENO,F_GETFL);
    if (flags < 0 || fcntl(STDOUT_FILENO,F_SETFL,flags | O_NONBLOCK) < 0) {
        fprintf(stderr,"Cannot configure bounded stdout writes\n"); return 1;
    }
    signal(SIGINT,stop); signal(SIGTERM,stop); signal(SIGPIPE,SIG_IGN);
    Context ci = {input != NULL,in == out}, co = {0,1}; AudioDeviceIOProcID pi = NULL, po = NULL;
    OSStatus status = AudioDeviceCreateIOProcID(in,io,&ci,&pi);
    if (!status && in != out) status = AudioDeviceCreateIOProcID(out,io,&co,&po);
    if (!status) status = AudioDeviceStart(in,pi);
    if (!status && po) status = AudioDeviceStart(out,po);
    if (status) { fprintf(stderr,"CoreAudio startup failed: %d\n",(int)status); stopping = 1; }
    else fprintf(stderr,"{\"type\":\"ready\",\"sampleRate\":48000,\"channels\":1,\"format\":\"PCM16LE\"}\n");
    pthread_t reader, writer; int threads = 0;
    if (!stopping) {
        if (pthread_create(&reader,NULL,read_stdin,NULL)) stopping = 1; else threads = 1;
        if (!stopping) { if (pthread_create(&writer,NULL,write_stdout,NULL)) stopping = 1; else threads = 2; }
    }
    while (!stopping) {
        sleep(1);
        fprintf(stderr,"{\"capturedSamples\":%llu,\"playedSamples\":%llu,\"droppedSamples\":%llu,\"underflowSamples\":%llu}\n",
            (unsigned long long)atomic_load(&captured),(unsigned long long)atomic_load(&played),
            (unsigned long long)atomic_load(&dropped),(unsigned long long)atomic_load(&silence));
    }
    if (pi) { AudioDeviceStop(in,pi); AudioDeviceDestroyIOProcID(in,pi); }
    if (po) { AudioDeviceStop(out,po); AudioDeviceDestroyIOProcID(out,po); }
    if (threads >= 1) pthread_join(reader,NULL); if (threads >= 2) pthread_join(writer,NULL);
    return status || !threads ? 1 : 0;
}
