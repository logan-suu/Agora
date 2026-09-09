#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Only bounded, fixed-shape results cross the private pipe; OS text is never returned. */
static int failure(OSStatus status) {
  fprintf(stderr, "keychain status %d\n", (int)status);
  if (status == errSecItemNotFound) return 10;
  if (status == errSecUserCanceled || status == errSecAuthFailed) return 11;
  if (status == errSecInteractionNotAllowed) return 12;
  return 13;
}
static CFMutableDictionaryRef query(const char *service, const char *account) {
  CFMutableDictionaryRef q = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFStringRef s = CFStringCreateWithCString(NULL, service, kCFStringEncodingUTF8);
  CFStringRef a = CFStringCreateWithCString(NULL, account, kCFStringEncodingUTF8);
  CFDictionarySetValue(q, kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(q, kSecAttrService, s);
  CFDictionarySetValue(q, kSecAttrAccount, a);
  CFRelease(s); CFRelease(a);
  return q;
}
static int read_key(CFMutableDictionaryRef q) {
  CFDictionarySetValue(q, kSecReturnRef, kCFBooleanTrue);
  CFDictionarySetValue(q, kSecMatchLimit, kSecMatchLimitAll);
  CFTypeRef found = NULL;
  OSStatus status = SecItemCopyMatching(q, &found);
  if (status != errSecSuccess) return failure(status);
  if (!found || CFGetTypeID(found) != CFArrayGetTypeID()) { if (found) CFRelease(found); return 13; }
  CFArrayRef values = (CFArrayRef)found;
  CFIndex count = CFArrayGetCount(values);
  if (count == 0) { CFRelease(found); return 10; }
  char first[44]; int result = 0;
  for (CFIndex i = 0; i < count; i++) {
    SecKeychainRef owner = NULL; SecKeychainStatus state = 0;
    status = SecKeychainItemCopyKeychain((SecKeychainItemRef)CFArrayGetValueAtIndex(values, i), &owner);
    if (status != errSecSuccess) { result = failure(status); break; }
    status = SecKeychainGetStatus(owner, &state); CFRelease(owner);
    if (status != errSecSuccess) { result = failure(status); break; }
    if (!(state & kSecUnlockStateStatus)) { result = 12; break; }
    UInt32 length = 0; void *data = NULL;
    status = SecKeychainItemCopyContent((SecKeychainItemRef)CFArrayGetValueAtIndex(values, i), NULL, NULL, &length, &data);
    if (status != errSecSuccess) { result = failure(status); break; }
    if (length != 44) result = 15;
    else if (i == 0) memcpy(first, data, 44);
    else if (memcmp(first, data, 44)) result = 14;
    SecKeychainItemFreeContent(NULL, data);
    if (result) break;
  }
  if (!result && fwrite(first, 1, 44, stdout) != 44) result = 13;
  memset(first, 0, sizeof(first)); CFRelease(found); return result;
}
int main(int argc, char **argv) {
  if ((argc != 4 && argc != 5) || (strcmp(argv[1], "read") && strcmp(argv[1], "create"))) return 13;
  /* Isolated test stores never prompt; login Keychain may request access authorization. */
  SecKeychainSetUserInteractionAllowed(argc != 5);
  CFMutableDictionaryRef q = query(argv[2], argv[3]);
  SecKeychainRef keychain = NULL;
  if (argc == 5) {
    OSStatus opened = SecKeychainOpen(argv[4], &keychain);
    if (opened != errSecSuccess) { CFRelease(q); return failure(opened); }
    CFArrayRef list = CFArrayCreate(NULL, (const void **)&keychain, 1, &kCFTypeArrayCallBacks);
    CFDictionarySetValue(q, kSecMatchSearchList, list); CFRelease(list);
  }
  if (!strcmp(argv[1], "create")) {
    char input[45]; size_t size = fread(input, 1, sizeof(input), stdin);
    if (size != 44) { CFRelease(q); if (keychain) CFRelease(keychain); return 15; }
    CFMutableDictionaryRef add = query(argv[2], argv[3]);
    if (keychain) CFDictionarySetValue(add, kSecUseKeychain, keychain);
    CFDataRef data = CFDataCreate(NULL, (const UInt8 *)input, 44);
    CFDictionarySetValue(add, kSecValueData, data);
    OSStatus status = SecItemAdd(add, NULL);
    memset(input, 0, sizeof(input)); CFRelease(data); CFRelease(add);
    if (status != errSecSuccess && status != errSecDuplicateItem) {
      CFRelease(q); if (keychain) CFRelease(keychain); return failure(status);
    }
  }
  int result = read_key(q);
  CFRelease(q); if (keychain) CFRelease(keychain);
  return result;
}
