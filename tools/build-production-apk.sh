#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

./gradlew verifyProductionSigning assembleRelease

APK="app/build/outputs/apk/release/app-release.apk"
test -f "$APK"

echo "Production APK: $APK"
shasum -a 256 "$APK"
