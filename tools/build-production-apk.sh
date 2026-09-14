#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

./gradlew verifyProductionSigning assembleSdk37Release

APK="app/build/outputs/apk/sdk37/release/app-sdk37-release.apk"
test -f "$APK"

echo "Production APK: $APK"
shasum -a 256 "$APK"
