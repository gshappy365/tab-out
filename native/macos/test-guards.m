#define main NativeHostMain
#import "SplitRatioHost.m"
#undef main
#include <assert.h>

int main(void) {
    @autoreleasepool {
        NSDictionary *initial=@{@"group":@"native-group-1",@"selected":@[@"overview",@"browser-A"]};
        assert(sameSelectedTabs(initial,initial));
        assert(sameSelectedTabs(initial,@{@"group":@"native-group-1",@"selected":@[@"browser-A",@"overview"]}));
        assert(!sameSelectedTabs(initial,@{@"group":@"native-group-1",@"selected":@[@"overview",@"browser-B"]}));
        assert(!sameSelectedTabs(initial,@{@"group":@"native-group-2",@"selected":@[@"overview",@"browser-A"]}));
        assert(!sameSelectedTabs(initial,@{@"group":@"native-group-1",@"selected":@[@"overview"]}));
        assert(!sameSelectedTabs(initial,@{@"group":@"native-group-1",@"selected":@[@"overview",@"browser-A",@"browser-B"]}));
        assert(!sameSelectedTabs(nil,initial));
        assert(!sameSelectedTabs(initial,nil));
        NSString *installed=@"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        assert(acceptableParentPath(installed,installed,@"Google Chrome",@"com.google.Chrome"));
        NSString *clone=@"/private/var/folders/x/X/com.google.Chrome.code_sign_clone/code_sign_clone.abc/Google Chrome.app.bundle/Contents/MacOS/Google Chrome";
        assert(acceptableParentPath(clone,installed,@"Google Chrome",@"com.google.Chrome"));
        assert(!acceptableParentPath(clone,installed,@"Google Chrome",@"com.google.chrome.for.testing"));
        assert(!acceptableParentPath([clone stringByReplacingOccurrencesOfString:@"Google Chrome.app.bundle" withString:@"Other.app.bundle"],
            installed,@"Google Chrome",@"com.google.Chrome"));
        assert(!acceptableParentPath([clone stringByReplacingOccurrencesOfString:@".code_sign_clone/code_sign_clone.abc" withString:@"/plain"],
            installed,@"Google Chrome",@"com.google.Chrome"));
        assert(!acceptableParentPath(@"/tmp/Google Chrome",installed,@"Google Chrome",@"com.google.Chrome"));
        assert(!acceptableParentPath(nil,installed,@"Google Chrome",@"com.google.Chrome"));
        assert(!sameSelectedTabs(@{@"group":@"native-group-1",@"selected":@[@"overview"]},
                                 @{@"group":@"native-group-1",@"selected":@[@"overview"]}));
        NSString *token=@"0123456789abcdef0123456789abcdef";
        NSDictionary *commit=@{@"version":@2,@"requestId":@"request",@"operation":@"commit-split-ratio",@"token":token};
        assert([commitAuthorization(commit,@"request",token) isEqual:@"commit"]);
        assert([commitAuthorization(@{@"version":@2,@"requestId":@"request",@"operation":@"abort-split-ratio",@"token":token},@"request",token) isEqual:@"abort"]);
        assert(!commitAuthorization(commit,@"other",token));
        assert(!commitAuthorization(commit,@"request",@"wrong-token"));
        assert(!commitAuthorization(@{@"version":@2,@"requestId":@"request",@"operation":@"commit-split-ratio"},@"request",token));
        assert(!commitAuthorization(@{@"version":@1,@"requestId":@"request",@"operation":@"commit-split-ratio",@"token":token},@"request",token));
        assert(!commitAuthorization(@{@"version":@YES,@"requestId":@"request",@"operation":@"commit-split-ratio",@"token":token},@"request",token));
        assert(!commitAuthorization(@{@"version":@2,@"requestId":@"request",@"operation":@"set-split-ratio",@"token":token},@"request",token));
        assert(!commitAuthorization(@{@"version":@2,@"requestId":@"request",@"operation":@"commit-split-ratio",@"token":token,@"extra":@1},@"request",token));
        assert(!commitAuthorization(nil,@"request",token));
        NSString *random=randomToken();
        assert(random.length==32);
        assert([random rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet]].location==NSNotFound);
        assert(![random isEqual:randomToken()]);
        int pipeFDs[2]; assert(pipe(pipeFDs)==0);
        int originalInput=dup(STDIN_FILENO); assert(originalInput>=0);
        assert(dup2(pipeFDs[0],STDIN_FILENO)>=0); close(pipeFDs[0]); close(pipeFDs[1]);
        assert(!readCommit(NSProcessInfo.processInfo.systemUptime+0.05)); // Disconnect: no authorization.
        assert(dup2(originalInput,STDIN_FILENO)>=0); close(originalInput);
        assert(pipe(pipeFDs)==0); originalInput=dup(STDIN_FILENO); assert(originalInput>=0);
        assert(dup2(pipeFDs[0],STDIN_FILENO)>=0); close(pipeFDs[0]);
        assert(!readCommit(NSProcessInfo.processInfo.systemUptime+0.01)); // Open pipe, no commit: bounded timeout.
        close(pipeFDs[1]); assert(dup2(originalInput,STDIN_FILENO)>=0); close(originalInput);
        puts("15 identity + 15 handshake guard assertions passed (no GUI operations)");
    }
    return 0;
}
