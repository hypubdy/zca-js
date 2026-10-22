// Bounded CoreAudio probe: only opens an explicitly selected virtual device.
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static double sample_rate = 48000, phase = 0;
static _Atomic unsigned long input_samples = 0, output_samples = 0;
static double input_energy = 0, peak = 0;
static double sine440 = 0, cosine440 = 0, sine997 = 0, cosine997 = 0;
static unsigned long input_frames = 0;

static OSStatus io(AudioDeviceID device, const AudioTimeStamp *now,
    const AudioBufferList *input, const AudioTimeStamp *in_time,
    AudioBufferList *output, const AudioTimeStamp *out_time, void *context) {
    (void)device; (void)now; (void)in_time; (void)out_time; (void)context;
    if (input) for (UInt32 b = 0; b < input->mNumberBuffers; b++) {
        const AudioBuffer *buffer = &input->mBuffers[b];
        if (!buffer->mData) continue;
        const float *samples = buffer->mData;
        unsigned long n = buffer->mDataByteSize / sizeof(float);
        for (unsigned long i = 0; i < n; i++) {
            double x = samples[i]; input_energy += x * x;
            if (fabs(x) > peak) peak = fabs(x);
            double time = (double)(input_frames + i / buffer->mNumberChannels) / sample_rate;
            sine440 += x * sin(2 * M_PI * 440 * time);
            cosine440 += x * cos(2 * M_PI * 440 * time);
            sine997 += x * sin(2 * M_PI * 997 * time);
            cosine997 += x * cos(2 * M_PI * 997 * time);
        }
        input_frames += n / buffer->mNumberChannels;
        atomic_fetch_add(&input_samples, n);
    }
    if (output) for (UInt32 b = 0; b < output->mNumberBuffers; b++) {
        AudioBuffer *buffer = &output->mBuffers[b];
        if (!buffer->mData || !buffer->mNumberChannels) continue;
        float *samples = buffer->mData;
        unsigned long n = buffer->mDataByteSize / sizeof(float);
        for (unsigned long i = 0; i < n; i += buffer->mNumberChannels) {
            float value = 0.1f * sin(phase);
            for (UInt32 c = 0; c < buffer->mNumberChannels && i + c < n; c++) samples[i + c] = value;
            phase += 2 * M_PI * 440 / sample_rate;
            if (phase > 2 * M_PI) phase -= 2 * M_PI;
        }
        atomic_fetch_add(&output_samples, n);
    }
    return noErr;
}

static int get_string(AudioDeviceID device, AudioObjectPropertySelector selector, char *out, size_t size) {
    AudioObjectPropertyAddress addr = {selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    CFStringRef string = NULL;
    UInt32 length = sizeof(string);
    OSStatus status = AudioObjectGetPropertyData(device, &addr, 0, NULL, &length, &string);
    if (status || !string) return 0;
    int ok = CFStringGetCString(string, out, size, kCFStringEncodingUTF8);
    CFRelease(string); return ok;
}

static int format(AudioDeviceID device, AudioObjectPropertyScope scope, AudioStreamBasicDescription *description) {
    AudioObjectPropertyAddress addr = {kAudioDevicePropertyStreamFormat, scope, kAudioObjectPropertyElementMain};
    UInt32 length = sizeof(*description);
    memset(description, 0, length);
    OSStatus status = AudioObjectGetPropertyData(device, &addr, 0, NULL, &length, description);
    return status == noErr;
}

int main(int argc, char **argv) {
    AudioObjectPropertyAddress addr = {kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    UInt32 size = 0;
    OSStatus status = AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, NULL, &size);
    if (status) { printf("{\"error\":\"enumerate\",\"status\":%d}\n", status); return 1; }
    AudioDeviceID *devices = malloc(size);
    status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, NULL, &size, devices);
    if (status) { free(devices); return 1; }
    AudioDeviceID selected = 0;
    AudioStreamBasicDescription selected_input = {0}, selected_output = {0};
    for (UInt32 i = 0; i < size / sizeof(AudioDeviceID); i++) {
        char uid[1024] = "", name[1024] = "";
        get_string(devices[i], kAudioDevicePropertyDeviceUID, uid, sizeof(uid));
        get_string(devices[i], kAudioObjectPropertyName, name, sizeof(name));
        AudioStreamBasicDescription input = {0}, output = {0};
        format(devices[i], kAudioObjectPropertyScopeInput, &input);
        format(devices[i], kAudioObjectPropertyScopeOutput, &output);
        // Only report names/formats, never capture from an enumerated physical device.
        printf("device=%s input_channels=%u output_channels=%u input_rate=%.0f output_rate=%.0f\n",
            name, input.mChannelsPerFrame, output.mChannelsPerFrame, input.mSampleRate, output.mSampleRate);
        if (argc == 2 && strcmp(argv[1], uid) == 0) {
            selected = devices[i]; selected_input = input; selected_output = output;
        }
    }
    free(devices);
    if (argc != 2) return 0;
    if (strcmp(argv[1], "MSLoopbackDriverDevice_UID") != 0) {
        fprintf(stderr, "This trial only admits the installed Teams virtual loopback UID.\n"); return 2;
    }
    if (!selected) { fprintf(stderr, "Virtual device not found\n"); return 2; }
    AudioStreamBasicDescription formats[] = {selected_input, selected_output};
    for (int i = 0; i < 2; i++) if (formats[i].mFormatID != kAudioFormatLinearPCM ||
        !(formats[i].mFormatFlags & kAudioFormatFlagIsFloat) || formats[i].mBitsPerChannel != 32 ||
        !formats[i].mChannelsPerFrame) {
        fprintf(stderr, "Unsupported format; refusing audio IO\n"); return 2;
    }
    sample_rate = selected_output.mSampleRate;
    AudioDeviceIOProcID proc = NULL;
    status = AudioDeviceCreateIOProcID(selected, io, NULL, &proc);
    printf("create_status=%d\n", status);
    if (status) return 1;
    status = AudioDeviceStart(selected, proc);
    printf("start_status=%d\n", status);
    if (!status) { sleep(2); AudioDeviceStop(selected, proc); }
    AudioDeviceDestroyIOProcID(selected, proc);
    unsigned long count = atomic_load(&input_samples);
    printf("input_samples=%lu output_samples=%lu input_rms=%.8f input_peak=%.8f\n",
        count, atomic_load(&output_samples), count ? sqrt(input_energy / count) : 0, peak);
    printf("tone440_amplitude=%.8f control997_amplitude=%.8f\n",
        count ? 2 * hypot(sine440, cosine440) / count : 0,
        count ? 2 * hypot(sine997, cosine997) / count : 0);
    return status ? 1 : 0;
}
