package com.caconnection.ui

/**
 * Small, deterministic privacy helpers shared by the on-device viewer and
 * sanitized debug export. None of these methods log or persist their input.
 */
object UiPrivacy {
    private val otpRegex = Regex("""(?<!\d)\d{4,8}(?!\d)""")
    private val urlRegex = Regex("""https?://\S+""", RegexOption.IGNORE_CASE)
    private val longSecretRegex = Regex("""(?<![A-Za-z0-9+/])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9+/])""")
    private val longNumberRegex = Regex("""(?<!\d)\+?\d[\d\s()-]{5,}\d(?!\d)""")

    fun extractOtp(body: String): String? =
        otpRegex.findAll(body)
            .map(MatchResult::value)
            .firstOrNull { it.length in 4..8 }

    fun maskAddress(value: String, unknownLabel: String): String {
        if (value.isBlank()) return unknownLabel
        val compact = value.filterNot(Char::isWhitespace)
        if (compact.length <= 4) return "••••"
        return "••••${compact.takeLast(4)}"
    }

    fun sanitizeDiagnosticText(value: String): String =
        value
            .replace(urlRegex, "[URL]")
            .replace(longSecretRegex, "[REDACTED]")
            .replace(longNumberRegex) { match ->
                val digits = match.value.filter(Char::isDigit)
                "••••${digits.takeLast(4)}"
            }
}
