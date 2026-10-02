/**
 * Passkey relying-party configuration (phase 8 item 3, app half). Pure data
 * with NO imports, like ./defaults.ts, so Node scripts
 * (scripts/check-passkeys.mjs) can load it under type stripping.
 *
 * WHAT THE rpId IS. A WebAuthn passkey is bound to a relying-party id: a
 * registrable domain name. The platform authenticator (iOS
 * AuthenticationServices, Android Credential Manager) creates and uses a
 * passkey for an rpId only when the app proves it is associated with that
 * domain:
 *  - iOS: the app's Associated Domains entitlement lists
 *    "webcredentials:<rpId>" (app.json ios.associatedDomains), and the
 *    domain serves https://<rpId>/.well-known/apple-app-site-association
 *    with {"webcredentials":{"apps":["<TeamID>.<bundle id>"]}}
 *    (react-native-passkeys 0.4.2 README, "iOS Setup").
 *  - Android: the domain serves https://<rpId>/.well-known/assetlinks.json
 *    granting the app's package name and signing-certificate SHA-256 the
 *    relations delegate_permission/common.handle_all_urls and
 *    delegate_permission/common.get_login_creds (react-native-passkeys 0.4.2
 *    README, "Android Setup"; developer.android.com/identity/
 *    credential-manager/prerequisites).
 *
 * The rpId must therefore be a domain the Chairperson controls. None has been
 * chosen yet, so the value below is a clearly marked PLACEHOLDER under the
 * RFC 2606 reserved top-level domain ".invalid", which can never resolve.
 * While it is set, every passkey entry point in the app refuses to run and
 * says that a development build with a configured rpId is needed
 * (wallet/passkeys.ts passkeyGate). To enable passkeys:
 *   1. set PASSKEY_RP_ID below to the real domain;
 *   2. replace "webcredentials:passkey-domain-not-configured.invalid" in
 *      app.json ios.associatedDomains with "webcredentials:<the domain>";
 *   3. host the two .well-known files on that domain;
 *   4. make a new development build (docs/DEVICE_BUILDS.md).
 * scripts/check-passkeys.mjs fails if app.json and this file disagree.
 *
 * The rpId is NOT checked on-chain (the WebAuthn validator ignores the
 * rpIdHash; packages/chains-evm/src/kernel-webauthn.ts), so it does not
 * protect funds by itself: it decides which app may use the passkey on the
 * device. The wallet still checks the rpIdHash locally on every response.
 */

/** The reserved, unresolvable placeholder (RFC 2606 ".invalid"). */
export const PASSKEY_RP_ID_PLACEHOLDER = 'passkey-domain-not-configured.invalid';

/** The relying-party id the app registers and asserts passkeys for. */
export const PASSKEY_RP_ID: string = PASSKEY_RP_ID_PLACEHOLDER;

/** Relying-party display name shown by the platform's passkey sheet. */
export const PASSKEY_RP_NAME = 'Shiba Wallet';
