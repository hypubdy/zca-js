// Private process-only CoreAudio tap. JSON stdout, optional PCM16LE mono fd 3.
// macOS requires user-approved System Audio Recording permission. No global tap.
#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#include <atomic>
#include <cmath>
#include <csignal>
#include <fcntl.h>
#include <unistd.h>
#include <cerrno>
#include <cstdlib>
static volatile sig_atomic_t stopping = 0;
static void stop(int) { stopping = 1; }
static constexpr uint64_t capacity = 131072;
static int16_t samples[capacity];
static std::atomic<uint64_t> readAt{0}, writeAt{0}, dropped{0}, captured{0};
static AudioStreamBasicDescription inputFormat;
static double nextSample = 0;
static uint64_t inputFrames = 0;
static float previousSample = 0;
static void emit(NSDictionary *message) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:message options:0 error:nil];
    fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout);
}
static void error(NSString *stage, OSStatus status, NSString *detail) {
    emit(@{@"type":@"error", @"stage":stage, @"status":@(status), @"message":detail});
}
static OSStatus io(AudioObjectID, const AudioTimeStamp *, const AudioBufferList *input,
    const AudioTimeStamp *, AudioBufferList *, const AudioTimeStamp *, void *) {
    if (!input || !input->mNumberBuffers) return noErr;
    const AudioBuffer &buffer = input->mBuffers[0];
    if (!buffer.mData || !buffer.mNumberChannels) return noErr;
    const bool planar = inputFormat.mFormatFlags & kAudioFormatFlagIsNonInterleaved;
    if (planar && input->mNumberBuffers < inputFormat.mChannelsPerFrame) return noErr;
    UInt32 frames = buffer.mDataByteSize / (sizeof(float) * buffer.mNumberChannels);
    for (UInt32 i = 0; i < frames; ++i) {
        float v = 0;
        for (UInt32 channel = 0; channel < inputFormat.mChannelsPerFrame; ++channel) {
            const AudioBuffer &source = input->mBuffers[planar ? channel : 0];
            if (!source.mData) continue;
            float value = ((const float *)source.mData)[planar ? i : i * source.mNumberChannels + channel];
            v += std::isfinite(value) ? value : 0;
        }
        v /= inputFormat.mChannelsPerFrame;
        while (nextSample <= (double)inputFrames) {
            double fraction = nextSample - ((double)inputFrames - 1);
            float value = inputFrames ? previousSample + (v - previousSample) * fraction : v;
            int16_t s = value >= 1 ? 32767 : value <= -1 ? -32768 : (int16_t)(value * 32768.f);
            uint64_t w = writeAt.load(std::memory_order_relaxed);
            if (w - readAt.load(std::memory_order_acquire) < capacity) {
                samples[w % capacity] = s; writeAt.store(w + 1, std::memory_order_release);
            } else dropped.fetch_add(1, std::memory_order_relaxed);
            captured.fetch_add(1, std::memory_order_relaxed);
            nextSample += inputFormat.mSampleRate / 48000.;
        }
        previousSample = v; ++inputFrames;
    }
    return noErr;
}
int main(int argc, char **argv) { @autoreleasepool {
    pid_t pid = 0; bool capture = true;
    for (int i = 1; i < argc; ++i) {
        if (!strcmp(argv[i], "--pid") && i + 1 < argc) {
            char *end = nullptr; long value = strtol(argv[++i], &end, 10);
            if (!end || *end || value <= 0 || value > INT32_MAX) return 2;
            pid = (pid_t)value;
        } else if (!strcmp(argv[i], "--capture-fd3")) capture = true;
        else { fprintf(stderr,"Usage: process-tap --pid PID [--capture-fd3]\n"); return 2; }
    }
    if (!pid) { fprintf(stderr,"An explicit helper PID is required\n"); return 2; }
    if (@available(macOS 14.2, *)) {
        if (capture) {
            int flags = fcntl(3, F_GETFL);
            if (flags < 0 || fcntl(3, F_SETFL, flags | O_NONBLOCK) < 0) {
                error(@"fd3", errno, @"Open writable fd 3 for PCM before using --capture-fd3"); return 2;
            }
        }
        signal(SIGTERM, stop); signal(SIGINT, stop); signal(SIGPIPE, SIG_IGN);
        AudioObjectID process = kAudioObjectUnknown, tap = kAudioObjectUnknown;
        AudioObjectPropertyAddress address = {kAudioHardwarePropertyTranslatePIDToProcessObject,
            kAudioObjectPropertyScopeGlobal,kAudioObjectPropertyElementMain};
        UInt32 size = sizeof(process);
        OSStatus status = AudioObjectGetPropertyData(kAudioObjectSystemObject,&address,sizeof(pid),&pid,&size,&process);
        if (status || process == kAudioObjectUnknown) {
            error(@"resolve-pid",status,@"PID has no CoreAudio process object yet; initialize helper audio and retry"); return 1;
        }
        CATapDescription *description = [[CATapDescription alloc] initMonoMixdownOfProcesses:@[@(process)]];
        description.name = @"ZaloCall private RX";
        description.privateTap = YES;
        description.muteBehavior = CATapMutedWhenTapped;
        status = AudioHardwareCreateProcessTap(description,&tap);
        if (status) {
            error(@"create-tap",status,@"macOS 14.2+ and System Audio Recording approval required; no permission bypass attempted"); return 1;
        }
        NSString *uid = [@"zca.call.rx." stringByAppendingString:NSUUID.UUID.UUIDString];
        NSDictionary *config = @{@kAudioAggregateDeviceNameKey:@"ZaloCall private RX",
            @kAudioAggregateDeviceUIDKey:uid, @kAudioAggregateDeviceIsPrivateKey:@YES,
            @kAudioAggregateDeviceIsStackedKey:@NO, @kAudioAggregateDeviceTapAutoStartKey:@NO,
            @kAudioAggregateDeviceTapListKey:@[@{@kAudioSubTapUIDKey:description.UUID.UUIDString,
                @kAudioSubTapDriftCompensationKey:@YES}]};
        AudioDeviceID device = kAudioObjectUnknown; AudioDeviceIOProcID proc = nullptr;
        status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)config,&device);
        if (status) error(@"create-aggregate",status,@"Cannot create private tap aggregate");
        AudioStreamBasicDescription format = {};
        if (!status && capture) {
            address = {kAudioDevicePropertyStreamFormat,kAudioObjectPropertyScopeInput,kAudioObjectPropertyElementMain};
            size = sizeof(format);
            status = AudioObjectGetPropertyData(device,&address,0,nullptr,&size,&format);
            if (!status && (format.mFormatID != kAudioFormatLinearPCM ||
                !(format.mFormatFlags & kAudioFormatFlagIsFloat) ||
                (format.mFormatFlags & kAudioFormatFlagIsBigEndian) || format.mBitsPerChannel != 32 ||
                (format.mChannelsPerFrame != 1 && format.mChannelsPerFrame != 2) ||
                (format.mSampleRate != 48000 && format.mSampleRate != 44100))) {
                status = kAudioHardwareUnsupportedOperationError;
            }
            if (status) error(@"input-format",status,@"Requires Float32 mono/stereo at 44100 or 48000 Hz");
            inputFormat = format;
            if (!status) status = AudioDeviceCreateIOProcID(device,io,nullptr,&proc);
            if (!status) status = AudioDeviceStart(device,proc);
            if (status) error(@"start-capture",status,@"Cannot read tap; verify System Audio Recording approval for the launching app");
        }
        if (!status) emit(@{@"type":@"ready",@"pid":@(pid),@"uid":uid,@"private":@YES,
            @"capture":@(capture),@"sampleRate":@48000,@"channels":@1,@"format":@"PCM16LE",
            @"note":@"Private UID is accessible only within this process; PCM on fd 3 when enabled"});
        unsigned char bytes[4096]; size_t pending = 0, offset = 0;
        while (!status && !stopping) {
            if (kill(pid,0) < 0 && errno == ESRCH) break;
            if (!capture) { usleep(10000); continue; }
            if (offset == pending) {
                pending = offset = 0;
                uint64_t r = readAt.load(std::memory_order_relaxed), w = writeAt.load(std::memory_order_acquire);
                while (r != w && pending + 2 <= sizeof(bytes)) {
                    uint16_t value = (uint16_t)samples[r++ % capacity];
                    bytes[pending++] = value & 255; bytes[pending++] = value >> 8;
                }
                readAt.store(r,std::memory_order_release);
            }
            if (offset < pending) {
                ssize_t count = write(3,bytes + offset,pending - offset);
                if (count > 0) offset += count;
                else if (count < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
                    error(@"write-pcm",errno,@"PCM consumer closed or failed"); status = -1;
                }
            }
            usleep(2000);
        }
        if (proc) { AudioDeviceStop(device,proc); AudioDeviceDestroyIOProcID(device,proc); }
        if (device != kAudioObjectUnknown) AudioHardwareDestroyAggregateDevice(device);
        AudioHardwareDestroyProcessTap(tap);
        emit(@{@"type":@"stopped",@"capturedSamples":@(captured.load()),@"droppedSamples":@(dropped.load())});
        return status ? 1 : 0;
    } else { error(@"platform",0,@"CoreAudio process taps require macOS 14.2 or newer"); return 1; }
} }
