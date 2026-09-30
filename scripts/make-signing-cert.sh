#!/usr/bin/env bash
# Create a stable local code-signing identity, so macOS permissions survive rebuilds.
#
# THE PROBLEM
# macOS stores Screen Recording and Microphone grants against the app's code
# signature. An ad-hoc signature (`codesign --sign -`) is a hash of the binary,
# so every rebuild produces a different identity, macOS sees a brand-new app,
# and the grant silently stops applying — while the toggle still reads "on".
#
# THE FIX
# Sign with a certificate instead. The stored requirement then references the
# certificate, which does not change when the binary does. Rebuild as often as
# you like; the grant sticks.
#
# This is a self-signed certificate used only on this machine. It is not a
# substitute for an Apple Developer ID, which is still required to distribute
# to anyone else (see docs/BACKLOG.md).
#
# Run once:  bash scripts/make-signing-cert.sh
set -euo pipefail

NAME="Glance Local Signing"

# NOTE: Keychain Access > Certificate Assistant > Create a Certificate
# (Self Signed Root, type Code Signing) does all of this correctly in one pass,
# and is the recommended route. This script exists for unattended setup, and
# has to reproduce four separate macOS requirements by hand: legacy PKCS12
# algorithms, a non-empty export password, keyUsage=digitalSignature, and a
# manual trust setting afterwards.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$NAME"; then
  echo "Identity '$NAME' already exists. Nothing to do."
  exit 0
fi

echo "==> generating a self-signed code-signing certificate"
openssl req -x509 -newkey rsa:2048 -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -days 3650 -nodes -subj "/CN=$NAME" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" \
  -addext "basicConstraints=critical,CA:false" 2>/dev/null
# keyUsage is not optional: without digitalSignature the certificate imports
# fine, shows as a valid identity, and codesign still refuses it with
# "Invalid Key Usage for policy".

# Legacy algorithms are REQUIRED here. OpenSSL 3.x defaults to AES-256-CBC with
# SHA-256, which macOS's `security` cannot read — it fails with "MAC verification
# failed during PKCS12 import (wrong password?)", which is misleading: the
# password is fine, the algorithm is unsupported.
openssl pkcs12 -export -out "$TMP/cert.p12" -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -passout pass:glance -name "$NAME" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 2>/dev/null

# Check it before importing, using the system LibreSSL — the same library
# `security` uses. Catching it here gives a clear error instead of a confusing one.
if ! /usr/bin/openssl pkcs12 -in "$TMP/cert.p12" -passin pass:glance -nokeys -noout >/dev/null 2>&1; then
  echo "The generated certificate is not in a format macOS can import." >&2
  echo "openssl in use: $(openssl version)" >&2
  exit 1
fi

echo "==> importing into your login keychain"
echo "    macOS may ask for your login password. This adds a signing identity"
echo "    used only to sign glance locally."
# A non-empty password matters: `security import` rejects password-less PKCS12
# files with the same misleading "MAC verification failed" error. The password
# protects nothing here — the file is deleted seconds later — it just has to exist.
security import "$TMP/cert.p12" -k "$HOME/Library/Keychains/login.keychain-db" \
  -P glance -T /usr/bin/codesign -A

echo
echo "==> identities available to codesign:"
security find-identity -v -p codesigning | grep "$NAME" || {
  echo "Import did not register an identity. Falling back to ad-hoc signing is safe;"
  echo "you will just have to re-grant permissions after each rebuild."
  exit 1
}

echo
echo "Done. Now run:"
echo "  npm run setup:hotkey            # rebuild, signed with the stable identity"
echo "  npm run agent:install"
echo
echo "Then grant Screen Recording and Microphone ONE more time. After this,"
echo "rebuilds will not reset them."
