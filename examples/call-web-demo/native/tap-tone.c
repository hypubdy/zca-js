// Synthetic output-only CoreAudio fixture. Silence until START on stdin; no mic.
#include <CoreAudio/CoreAudio.h>
#include <math.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <poll.h>
static volatile sig_atomic_t stopping;
static _Atomic int enabled;
static double phase, rate = 48000, frequency = 440, amplitude = .05;
static void stop(int n) { (void)n; stopping = 1; }
static OSStatus io(AudioDeviceID device, const AudioTimeStamp *now, const AudioBufferList *input,
    const AudioTimeStamp *inputTime, AudioBufferList *output, const AudioTimeStamp *outputTime, void *context) {
    (void)device; (void)now; (void)input; (void)inputTime; (void)outputTime; (void)context;
    if (!output || !output->mNumberBuffers) return noErr;
    AudioBuffer *first = &output->mBuffers[0];
    if (!first->mNumberChannels) return noErr;
    UInt32 frames = first->mDataByteSize / (sizeof(float) * first->mNumberChannels);
    int active = atomic_load_explicit(&enabled, memory_order_relaxed);
    for (UInt32 frame = 0; frame < frames; ++frame) {
        float sample = active ? (float)(sin(phase) * amplitude) : 0;
        phase += 2 * M_PI * frequency / rate; if (phase >= 2 * M_PI) phase -= 2 * M_PI;
        for (UInt32 b = 0; b < output->mNumberBuffers; ++b) {
            AudioBuffer *buffer = &output->mBuffers[b];
            if (!buffer->mData || (frame + 1) * sizeof(float) * buffer->mNumberChannels > buffer->mDataByteSize) continue;
            float *values = buffer->mData;
            for (UInt32 channel = 0; channel < buffer->mNumberChannels; ++channel)
                values[frame * buffer->mNumberChannels + channel] = sample;
        }
    }
    return noErr;
}
int main(int argc, char **argv) {
    if (argc > 1) frequency = strtod(argv[1],NULL);
    if (argc > 2) amplitude = strtod(argv[2],NULL);
    if (!isfinite(frequency) || frequency < 100 || frequency > 2000 || !isfinite(amplitude) || amplitude < 0 || amplitude > .05) return 2;
    signal(SIGTERM,stop); signal(SIGINT,stop);
    AudioDeviceID device = kAudioObjectUnknown; UInt32 size = sizeof(device);
    AudioObjectPropertyAddress address = {kAudioHardwarePropertyDefaultOutputDevice,kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
    OSStatus status = AudioObjectGetPropertyData(kAudioObjectSystemObject,&address,0,NULL,&size,&device);
    if (status || device == kAudioObjectUnknown) return 1;
    AudioStreamBasicDescription format = {0}; size = sizeof(format);
    address = (AudioObjectPropertyAddress){kAudioDevicePropertyStreamFormat,kAudioObjectPropertyScopeOutput,kAudioObjectPropertyElementMain};
    status = AudioObjectGetPropertyData(device,&address,0,NULL,&size,&format);
    if (status || format.mFormatID != kAudioFormatLinearPCM || !(format.mFormatFlags & kAudioFormatFlagIsFloat) ||
        (format.mFormatFlags & kAudioFormatFlagIsBigEndian) || format.mBitsPerChannel != 32 ||
        (format.mChannelsPerFrame != 1 && format.mChannelsPerFrame != 2) ||
        (format.mSampleRate != 44100 && format.mSampleRate != 48000)) {
        fprintf(stderr,"Unsupported default output format\n"); return 1;
    }
    rate = format.mSampleRate;
    AudioDeviceIOProcID proc = NULL;
    status = AudioDeviceCreateIOProcID(device,io,NULL,&proc);
    if (!status) status = AudioDeviceStart(device,proc);
    if (status) fprintf(stderr,"CoreAudio output startup failed: %d\n",(int)status);
    else { printf("{\"type\":\"ready\",\"pid\":%d,\"rate\":%.0f,\"frequency\":%.0f}\n",getpid(),rate,frequency); fflush(stdout); }
    char command[64]; size_t used = 0;
    while (!status && !stopping) {
        struct pollfd fd = {STDIN_FILENO,POLLIN,0}; if (poll(&fd,1,100) <= 0) continue;
        char c; if (read(STDIN_FILENO,&c,1) <= 0) break;
        if (c == '\n') {
            command[used] = 0;
            if (!strcmp(command,"START")) atomic_store(&enabled,1);
            else if (!strcmp(command,"STOP")) atomic_store(&enabled,0);
            else if (!strcmp(command,"QUIT")) break;
            used = 0;
        } else if (used + 1 < sizeof(command)) command[used++] = c;
    }
    if (proc) { AudioDeviceStop(device,proc); AudioDeviceDestroyIOProcID(device,proc); }
    return status ? 1 : 0;
}
