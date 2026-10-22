// Process-scoped Accessibility bridge. Never sends global keys or coordinates.
// clang -fobjc-arc -framework Foundation -framework ApplicationServices helper-ui.m -o helper-ui
// helper-ui probe PID /absolute/path/to/ZaloCall
// helper-ui press PID /absolute/path/to/ZaloCall EXACT_BUTTON_LABEL_OR_IDENTIFIER
#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>
#include <libproc.h>
#include <limits.h>

static void emit(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
}

static NSString *attribute(AXUIElementRef element, CFStringRef name) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess || !value) return @"";
    NSString *result = CFGetTypeID(value) == CFStringGetTypeID() ? [(__bridge NSString *)value copy] : @"";
    CFRelease(value);
    return result;
}

static void visit(AXUIElementRef element, NSMutableArray *buttons, NSMutableArray *matches,
                  NSString *target, NSUInteger depth, NSUInteger *visited) {
    if (depth > 24 || *visited >= 2048) return;
    ++*visited;
    if ([attribute(element, kAXRoleAttribute) isEqualToString:(__bridge NSString *)kAXButtonRole]) {
        NSString *title = attribute(element, kAXTitleAttribute);
        NSString *description = attribute(element, kAXDescriptionAttribute);
        NSString *identifier = attribute(element, CFSTR("AXIdentifier"));
        [buttons addObject:@{@"title":title, @"description":description, @"identifier":identifier}];
        if (target.length && ([title isEqualToString:target] || [description isEqualToString:target] ||
                              [identifier isEqualToString:target])) {
            [matches addObject:(__bridge id)element];
        }
    }
    CFTypeRef children = NULL;
    if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children) == kAXErrorSuccess && children) {
        if (CFGetTypeID(children) == CFArrayGetTypeID()) {
            for (id child in (__bridge NSArray *)children) {
                if (CFGetTypeID((__bridge CFTypeRef)child) == AXUIElementGetTypeID())
                    visit((__bridge AXUIElementRef)child, buttons, matches, target, depth + 1, visited);
            }
        }
        CFRelease(children);
    }
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        BOOL press = argc == 5 && strcmp(argv[1], "press") == 0;
        BOOL probe = argc == 4 && strcmp(argv[1], "probe") == 0;
        if (!press && !probe) {
            emit(@{@"ok":@NO, @"error":@"usage: helper-ui probe|press PID ABSOLUTE_EXECUTABLE [EXACT_BUTTON_LABEL_OR_IDENTIFIER]"});
            return 2;
        }
        char *end = NULL;
        long rawPid = strtol(argv[2], &end, 10);
        char actual[PROC_PIDPATHINFO_MAXSIZE], expected[PATH_MAX];
        if (!end || *end || rawPid <= 0 || rawPid > INT_MAX || argv[3][0] != '/' ||
            !realpath(argv[3], expected) || proc_pidpath((pid_t)rawPid, actual, sizeof(actual)) <= 0 ||
            strcmp(actual, expected) != 0 || strcmp(strrchr(expected, '/') + 1, "ZaloCall") != 0) {
            emit(@{@"ok":@NO, @"error":@"PID does not match the selected ZaloCall executable"});
            return 3;
        }
        // Do not trigger permission prompts or alter TCC settings.
        if (!AXIsProcessTrusted()) {
            emit(@{@"ok":@NO, @"error":@"accessibility_permission_required",
                   @"detail":@"Grant Accessibility access to the launching app in macOS System Settings, then retry."});
            return 4;
        }
        AXUIElementRef app = AXUIElementCreateApplication((pid_t)rawPid);
        AXUIElementSetMessagingTimeout(app, 2.0);
        NSMutableArray *buttons = [NSMutableArray array], *matches = [NSMutableArray array];
        NSString *target = press ? [NSString stringWithUTF8String:argv[4]] : @"";
        NSUInteger visited = 0;
        visit(app, buttons, matches, target, 0, &visited);
        if (probe) emit(@{@"ok":@YES, @"buttons":buttons, @"nodesVisited":@(visited),
                          @"truncated":@(visited >= 2048)});
        else if (matches.count != 1) {
            emit(@{@"ok":@NO, @"error":@"expected_exactly_one_matching_button", @"matches":@(matches.count)});
            CFRelease(app);
            return 5;
        } else {
            AXUIElementRef button = (__bridge AXUIElementRef)matches[0];
            CFTypeRef enabled = NULL;
            AXError stateError = AXUIElementCopyAttributeValue(button, kAXEnabledAttribute, &enabled);
            BOOL canPress = stateError == kAXErrorSuccess && enabled == kCFBooleanTrue;
            if (enabled) CFRelease(enabled);
            AXError status = canPress ? AXUIElementPerformAction(button, kAXPressAction) : kAXErrorActionUnsupported;
            emit(@{@"ok":@(status == kAXErrorSuccess), @"axError":@(status)});
            CFRelease(app);
            return status == kAXErrorSuccess ? 0 : 6;
        }
        CFRelease(app);
        return 0;
    }
}
