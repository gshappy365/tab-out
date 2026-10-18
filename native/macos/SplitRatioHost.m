#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <libproc.h>
#include <poll.h>
#include <unistd.h>
#include <math.h>
#include <signal.h>

static const NSUInteger MaxFrame = 16384;
static NSTimeInterval deadline;
static NSTimeInterval launchedAt;
static id attribute(AXUIElementRef element, CFStringRef key) {
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(element, key, &value) != kAXErrorSuccess) return nil;
    return CFBridgingRelease(value);
}
static CGRect bounds(AXUIElementRef element) {
    id position = attribute(element, kAXPositionAttribute), size = attribute(element, kAXSizeAttribute);
    CGPoint p = CGPointZero; CGSize s = CGSizeZero;
    if (!position || !size || CFGetTypeID((__bridge CFTypeRef)position) != AXValueGetTypeID() ||
        CFGetTypeID((__bridge CFTypeRef)size) != AXValueGetTypeID() ||
        !AXValueGetValue((__bridge AXValueRef)position, kAXValueCGPointType, &p) ||
        !AXValueGetValue((__bridge AXValueRef)size, kAXValueCGSizeType, &s)) return CGRectNull;
    return (CGRect){p,s};
}
static BOOL sameBounds(CGRect a, CGRect b) {
    return !CGRectIsNull(a) && !CGRectIsNull(b) && fabs(a.origin.x-b.origin.x)<=2 &&
        fabs(a.origin.y-b.origin.y)<=2 && fabs(a.size.width-b.size.width)<=2 && fabs(a.size.height-b.size.height)<=2;
}
static BOOL expired(void) { return NSProcessInfo.processInfo.systemUptime >= deadline; }
static BOOL readBytesUntil(void *buffer, size_t length, NSTimeInterval until) {
    size_t count = 0;
    while (count < length && NSProcessInfo.processInfo.systemUptime < until) {
        struct pollfd input = {.fd=STDIN_FILENO,.events=POLLIN};
        int remaining = MAX(1,(int)((until-NSProcessInfo.processInfo.systemUptime)*1000));
        if (poll(&input,1,remaining)<=0) return NO;
        ssize_t result=read(STDIN_FILENO,(char *)buffer+count,length-count);
        if (result<=0) return NO;
        count+=(size_t)result;
    }
    return count==length;
}
static BOOL readBytes(void *buffer, size_t length) { return readBytesUntil(buffer,length,deadline); }
static BOOL number(id value, double min, double max) {
    return [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value)!=CFBooleanGetTypeID() &&
        isfinite([value doubleValue]) && [value doubleValue]>=min && [value doubleValue]<=max;
}
static BOOL keys(NSDictionary *value, NSArray *expected) {
    return [value isKindOfClass:NSDictionary.class] && [[NSSet setWithArray:value.allKeys] isEqualToSet:[NSSet setWithArray:expected]];
}
static NSDictionary *response(NSString *requestId, NSString *status, NSString *reason) {
    NSMutableDictionary *value=[@{@"version":@2,@"requestId":requestId?:@"",@"status":status} mutableCopy];
    if (reason) value[@"reason"]=reason;
    return value;
}
static BOOL writeFrame(NSDictionary *value) {
    NSData *data=[NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
    if (!data || data.length>MaxFrame) return NO;
    uint32_t length=(uint32_t)data.length;
    return fwrite(&length,sizeof(length),1,stdout)==1 && fwrite(data.bytes,data.length,1,stdout)==1 && fflush(stdout)==0;
}
static NSString *commitAuthorization(NSDictionary *request, NSString *identifier, NSString *token) {
    if (!keys(request,@[@"version",@"requestId",@"operation",@"token"]) || !number(request[@"version"],2,2) ||
        ![request[@"requestId"] isEqual:identifier] || ![request[@"token"] isEqual:token]) return nil;
    if ([request[@"operation"] isEqual:@"commit-split-ratio"]) return @"commit";
    if ([request[@"operation"] isEqual:@"abort-split-ratio"]) return @"abort";
    return nil;
}
static NSDictionary *readCommit(NSTimeInterval until) {
    uint32_t length=0;
    if (!readBytesUntil(&length,sizeof(length),until) || !length || length>MaxFrame) return nil;
    NSMutableData *data=[NSMutableData dataWithLength:length];
    if (!readBytesUntil(data.mutableBytes,length,until)) return nil;
    id value=[NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
    return [value isKindOfClass:NSDictionary.class]?value:nil;
}
static NSString *randomToken(void) {
    unsigned char random[16]; arc4random_buf(random,sizeof(random));
    NSMutableString *token=[NSMutableString stringWithCapacity:32];
    for (NSUInteger i=0;i<sizeof(random);i++) [token appendFormat:@"%02x",random[i]];
    return token;
}
static NSString *normalizedPath(NSString *path) {
    return path ? [[path stringByResolvingSymlinksInPath] stringByStandardizingPath] : nil;
}
// Chrome's macOS in-place updates can leave the running main process in a code-sign clone while the
// application still reports its installed bundle. Accept only the exact clone layout for that bundle:
// ".../X/<bundle id>.code_sign_clone/code_sign_clone.* /<App>.app.bundle/Contents/MacOS/<exe>".
static BOOL acceptableParentPath(NSString *actual, NSString *expected, NSString *executable, NSString *bundleIdentifier) {
    if (!actual.length || !expected.length || !executable.length || !bundleIdentifier.length) return NO;
    if ([actual isEqualToString:expected]) return YES;
    NSArray *components=actual.pathComponents, *installed=expected.pathComponents;
    if (components.count<5 || installed.count<5) return NO;
    BOOL sameLayout=[components[components.count-1] isEqualToString:executable] &&
        [components[components.count-2] isEqualToString:@"MacOS"] &&
        [components[components.count-3] isEqualToString:@"Contents"] &&
        [components[components.count-4] isEqualToString:[installed[installed.count-4] stringByAppendingString:@".bundle"]];
    return sameLayout && [actual containsString:[bundleIdentifier stringByAppendingString:@".code_sign_clone"]];
}
static NSRunningApplication *parentBrowser(void) {
    pid_t pid=getppid(); char path[PROC_PIDPATHINFO_MAXSIZE]={0};
    if (pid<=1 || proc_pidpath(pid,path,sizeof(path))<=0) return nil;
    NSRunningApplication *app=[NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (![@[@"com.google.Chrome",@"com.google.chrome.for.testing"] containsObject:app.bundleIdentifier]) return nil;
    NSBundle *bundle=[NSBundle bundleWithURL:app.bundleURL];
    NSString *executable=[bundle objectForInfoDictionaryKey:@"CFBundleExecutable"];
    if (!executable.length) return nil;
    NSString *actual=normalizedPath(@(path));
    NSString *expected=normalizedPath(app.executableURL.path);
    NSString *main=normalizedPath([[app.bundleURL.path stringByAppendingPathComponent:@"Contents/MacOS"] stringByAppendingPathComponent:executable]);
    if (!expected || !main || ![expected isEqualToString:main]) return nil;
    return acceptableParentPath(actual,expected,executable,app.bundleIdentifier) ? app : nil;
}
static BOOL collectDividers(AXUIElementRef element, NSUInteger depth, NSUInteger *count, NSMutableArray *found) {
    if (expired() || depth>25 || ++*count>5000) return NO;
    NSString *role=attribute(element,kAXRoleAttribute);
    if ([role isEqualToString:@"AXWebArea"]) return YES;
    if ([role isEqualToString:(__bridge NSString *)kAXSliderRole]) {
        NSString *description=attribute(element,kAXDescriptionAttribute);
        if ([description isKindOfClass:NSString.class] &&
            ([description localizedCaseInsensitiveContainsString:@"split"] || [description containsString:@"分屏"] || [description containsString:@"拆分"]))
            [found addObject:(__bridge id)element];
    }
    NSArray *children=attribute(element,kAXChildrenAttribute);
    if (![children isKindOfClass:NSArray.class]) return YES;
    for (id child in children) if (!collectDividers((__bridge AXUIElementRef)child,depth+1,count,found)) return NO;
    return YES;
}
static BOOL collectSelectedRadios(AXUIElementRef element, NSUInteger depth, NSUInteger *count, NSMutableArray *selected) {
    if (expired() || depth>25 || ++*count>5000) return NO;
    NSString *role=attribute(element,kAXRoleAttribute);
    if ([role isEqualToString:@"AXWebArea"]) return YES;
    if ([role isEqualToString:(__bridge NSString *)kAXRadioButtonRole]) {
        id value=attribute(element,kAXValueAttribute);
        if (![value isKindOfClass:NSNumber.class]) return NO;
        if ([value boolValue]) [selected addObject:(__bridge id)element];
    }
    NSArray *children=attribute(element,kAXChildrenAttribute);
    if (![children isKindOfClass:NSArray.class]) return YES;
    for (id child in children) if (!collectSelectedRadios((__bridge AXUIElementRef)child,depth+1,count,selected)) return NO;
    return YES;
}
static BOOL collectSelectedTabGroups(AXUIElementRef element, NSUInteger depth, NSUInteger *count, NSMutableArray *groups) {
    if (expired() || depth>25 || ++*count>5000) return NO;
    NSString *role=attribute(element,kAXRoleAttribute);
    if ([role isEqualToString:@"AXWebArea"]) return YES;
    if ([role isEqualToString:(__bridge NSString *)kAXTabGroupRole]) {
        NSMutableArray *selected=[NSMutableArray array]; NSUInteger radioCount=0;
        if (!collectSelectedRadios(element,0,&radioCount,selected)) return NO;
        if (selected.count) [groups addObject:@{@"group":(__bridge id)element,@"selected":selected}];
        return YES;
    }
    NSArray *children=attribute(element,kAXChildrenAttribute);
    if (![children isKindOfClass:NSArray.class]) return YES;
    for (id child in children) if (!collectSelectedTabGroups((__bridge AXUIElementRef)child,depth+1,count,groups)) return NO;
    return YES;
}
static NSDictionary *selectedTabs(AXUIElementRef window) {
    NSMutableArray *groups=[NSMutableArray array]; NSUInteger count=0;
    if (!collectSelectedTabGroups(window,0,&count,groups) || groups.count!=1) return nil;
    NSDictionary *group=groups.firstObject;
    NSUInteger selectedCount=[group[@"selected"] count];
    return selectedCount==2 ? group : nil;
}
static BOOL sameSelectedTabs(NSDictionary *before, NSDictionary *after) {
    if (!before || !after || !CFEqual((__bridge CFTypeRef)before[@"group"],(__bridge CFTypeRef)after[@"group"])) return NO;
    NSArray *old=before[@"selected"], *now=after[@"selected"];
    if (old.count!=2 || now.count!=2) return NO;
    for (id tab in old) {
        BOOL found=NO;
        for (id current in now) if (CFEqual((__bridge CFTypeRef)tab,(__bridge CFTypeRef)current)) { found=YES; break; }
        if (!found) return NO;
    }
    return YES;
}
static BOOL currentWindow(NSRunningApplication *app, AXUIElementRef application, AXUIElementRef window, CGRect expected) {
    if (expired() || NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier!=app.processIdentifier || !sameBounds(bounds(window),expected)) return NO;
    id focused=attribute(application,kAXFocusedWindowAttribute);
    return focused && CFEqual((__bridge CFTypeRef)focused,window);
}
static BOOL currentSplit(NSRunningApplication *app, AXUIElementRef application, AXUIElementRef window,
                         CGRect expected, NSDictionary *tabs, AXUIElementRef slider, CGRect sliderBounds) {
    if (!currentWindow(app,application,window,expected) || !sameSelectedTabs(tabs,selectedTabs(window))) return NO;
    NSMutableArray *dividers=[NSMutableArray array]; NSUInteger count=0;
    if (!collectDividers(window,0,&count,dividers) || dividers.count!=1 ||
        !CFEqual((__bridge CFTypeRef)dividers.firstObject,slider)) return NO;
    CGRect current=bounds(slider);
    return !CGRectIsNull(current) && CGRectContainsRect(expected,current) &&
        fabs(current.origin.y-sliderBounds.origin.y)<=2 && fabs(current.size.width-sliderBounds.size.width)<=2 &&
        fabs(current.size.height-sliderBounds.size.height)<=2 && !expired();
}
static void postMouse(CGEventSourceRef source, CGEventType type, CGPoint point) {
    CGEventRef event=CGEventCreateMouseEvent(source,type,point,kCGMouseButtonLeft);
    if (event) { CGEventPost(kCGHIDEventTap,event); CFRelease(event); }
}
static NSDictionary *handle(NSDictionary *request) {
    NSString *identifier=[request[@"requestId"] isKindOfClass:NSString.class]?request[@"requestId"]:@"";
    if (!number(request[@"version"],2,2) || identifier.length<1 || identifier.length>128 ||
        [identifier rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location!=NSNotFound)
        return response(identifier,@"refused",@"invalid-request");
    BOOL status=[request[@"operation"] isEqual:@"status"];
    if (!keys(request,status?@[@"version",@"requestId",@"operation"]:@[@"version",@"requestId",@"operation",@"expiresAt",@"overviewSide",@"viewportWidths",@"windowBounds",@"targetRatio"]) ||
        (!status && ![request[@"operation"] isEqual:@"set-split-ratio"])) return response(identifier,@"refused",@"invalid-request");
    if (status) {
        if (!parentBrowser()) return response(identifier,@"refused",@"untrusted-parent");
        return AXIsProcessTrusted()?response(identifier,@"already-correct",@"ready"):response(identifier,@"permission-required",@"accessibility");
    }
    NSDictionary *widths=request[@"viewportWidths"], *windowBounds=request[@"windowBounds"];
    if (!keys(widths,@[@"left",@"right"]) || !keys(windowBounds,@[@"left",@"top",@"width",@"height"]) ||
        ![@[@"left",@"right"] containsObject:request[@"overviewSide"]] ||
        !number(widths[@"left"],100,16000) || !number(widths[@"right"],100,16000) ||
        !number(windowBounds[@"left"],-40000,40000) || !number(windowBounds[@"top"],-40000,40000) ||
        !number(windowBounds[@"width"],400,32000) || !number(windowBounds[@"height"],200,32000) ||
        !number(request[@"targetRatio"],0.20,0.60) || !number(request[@"expiresAt"],0,1e15))
        return response(identifier,@"refused",@"invalid-request");
    double remaining=[request[@"expiresAt"] doubleValue]/1000-NSDate.date.timeIntervalSince1970;
    if (remaining<=0) return response(identifier,@"refused",@"expired");
    deadline=MIN(launchedAt+6.0,NSProcessInfo.processInfo.systemUptime+remaining);
    CGRect expected=CGRectMake([windowBounds[@"left"] doubleValue],[windowBounds[@"top"] doubleValue],[windowBounds[@"width"] doubleValue],[windowBounds[@"height"] doubleValue]);
    double left=[widths[@"left"] doubleValue],right=[widths[@"right"] doubleValue],total=left+right;
    if (total>expected.size.width || expected.size.width-total>200) return response(identifier,@"refused",@"viewport-mismatch");
    NSRunningApplication *app=parentBrowser();
    if (!app) return response(identifier,@"refused",@"untrusted-parent");
    if (!AXIsProcessTrusted()) return response(identifier,@"permission-required",@"accessibility");
    AXUIElementRef application=AXUIElementCreateApplication(app.processIdentifier);
    AXUIElementSetMessagingTimeout(application,0.15);
    AXUIElementSetAttributeValue(application,CFSTR("AXManualAccessibility"),kCFBooleanTrue);
    AXUIElementSetAttributeValue(application,CFSTR("AXEnhancedUserInterface"),kCFBooleanTrue);
    NSDictionary *result=nil;
    @try {
        NSArray *windows=attribute(application,kAXWindowsAttribute);
        NSMutableArray *matching=[NSMutableArray array];
        for (id candidate in windows) if (sameBounds(bounds((__bridge AXUIElementRef)candidate),expected)) [matching addObject:candidate];
        if (matching.count!=1) return response(identifier,@"refused",@"window-mismatch");
        AXUIElementRef window=(__bridge AXUIElementRef)matching.firstObject;
        if (!currentWindow(app,application,window,expected)) return response(identifier,@"refused",@"foreground-changed");
        NSUInteger count=0; NSMutableArray *dividers=[NSMutableArray array];
        if (!collectDividers(window,0,&count,dividers) || dividers.count!=1) return response(identifier,@"refused",@"divider-mismatch");
        CGRect divider=bounds((__bridge AXUIElementRef)dividers.firstObject);
        AXUIElementRef slider=(__bridge AXUIElementRef)dividers.firstObject;
        NSDictionary *tabs=selectedTabs(window);
        if (!tabs) return response(identifier,@"refused",@"tab-identity-unavailable");
        CGPoint start=CGPointMake(CGRectGetMidX(divider),CGRectGetMidY(divider));
        if (CGRectIsNull(divider) || divider.size.width<1 || divider.size.width>40 || divider.size.height<10 ||
            !CGRectContainsRect(expected,divider)) return response(identifier,@"refused",@"divider-mismatch");
        double target=[request[@"targetRatio"] doubleValue];
        double desired=[request[@"overviewSide"] isEqual:@"left"]?target:1-target;
        CGPoint end=CGPointMake(start.x+desired*total-left,start.y);
        if (!CGRectContainsPoint(expected,end) || CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState,kCGMouseButtonLeft)) return response(identifier,@"refused",@"unsafe-drag");
        if (!currentSplit(app,application,window,expected,tabs,slider,divider)) return response(identifier,@"refused",@"split-changed");
        NSString *token=randomToken();
        if (!writeFrame(@{@"version":@2,@"requestId":identifier,@"status":@"prepared",@"token":token}))
            return response(identifier,@"refused",@"disconnected");
        NSDictionary *commit=readCommit(MIN(deadline,NSProcessInfo.processInfo.systemUptime+2.0));
        if (!commit) return response(identifier,@"refused",@"commit-missing");
        NSString *authorization=commitAuthorization(commit,identifier,token);
        if (!authorization) return response(identifier,@"refused",@"invalid-commit");
        if ([authorization isEqual:@"abort"]) return response(identifier,@"refused",@"aborted");
        if (!currentSplit(app,application,window,expected,tabs,slider,divider) || !sameBounds(bounds(slider),divider))
            return response(identifier,@"refused",@"split-changed");
        if (fabs(left/total-desired)<=0.005) return response(identifier,@"already-correct",nil);
        if (CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState,kCGMouseButtonLeft)) return response(identifier,@"refused",@"unsafe-drag");
        CGEventSourceRef source=CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
        if (!source) return response(identifier,@"error",@"event-source");
        CGEventSourceSetLocalEventsSuppressionInterval(source,0.0);
        BOOL down=NO,finished=NO; CGPoint last=start;
        @try {
            if (!currentSplit(app,application,window,expected,tabs,slider,divider)) return response(identifier,@"refused",@"split-changed");
            postMouse(source,kCGEventMouseMoved,start); usleep(20000);
            if (!currentSplit(app,application,window,expected,tabs,slider,divider)) return response(identifier,@"refused",@"split-changed");
            down=YES; postMouse(source,kCGEventLeftMouseDown,start); usleep(40000);
            // Cheap foreground/geometry guard every step; the expensive AX identity walk runs
            // before mouse-down and again after commit, so the drag stays responsive.
            for (int step=1;step<=16;step++) {
                if (expired() || !currentWindow(app,application,window,expected)) break;
                last=CGPointMake(start.x+(end.x-start.x)*step/16.0,start.y);
                postMouse(source,kCGEventLeftMouseDragged,last); usleep(8000);
                if (step==16) finished=YES;
            }
        } @finally {
            if (down) postMouse(source,kCGEventLeftMouseUp,last);
            CFRelease(source);
        }
        result=response(identifier,finished?@"adjusted":@"refused",finished?nil:@"interrupted");
    } @finally { CFRelease(application); }
    return result;
}
int main(int argc, const char *argv[]) {
    @autoreleasepool {
        signal(SIGPIPE,SIG_IGN);
        launchedAt=NSProcessInfo.processInfo.systemUptime;
        deadline=launchedAt+3.0;
        uint32_t length=0; NSDictionary *result=nil;
        if (!readBytes(&length,sizeof(length)) || length==0 || length>MaxFrame) result=response(@"",@"refused",@"invalid-frame");
        else {
            NSMutableData *data=[NSMutableData dataWithLength:length];
            if (!readBytes(data.mutableBytes,length)) result=response(@"",@"refused",@"incomplete-frame");
            else {
                id request=[NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
                @try {
                    NSString *origin=argc==2?@(argv[1]):@"";
                    NSRegularExpression *pattern=[NSRegularExpression regularExpressionWithPattern:@"\\Achrome-extension://[a-p]{32}/\\z" options:0 error:NULL];
                    if ([pattern numberOfMatchesInString:origin options:0 range:NSMakeRange(0,origin.length)]!=1) result=response(@"",@"refused",@"invalid-origin");
                    else result=[request isKindOfClass:NSDictionary.class]?handle(request):response(@"",@"refused",@"invalid-json");
                }
                @catch (NSException *exception) { result=response(@"",@"error",@"internal"); }
            }
        }
        writeFrame(result);
    }
    return 0;
}
