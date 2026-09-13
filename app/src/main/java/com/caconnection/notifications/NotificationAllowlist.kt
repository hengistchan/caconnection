package com.caconnection.notifications

import android.content.Context
import androidx.core.content.edit

object NotificationAllowlist {
    private const val PREFERENCES = "notification_capture"
    private const val KEY_PACKAGES = "allowed_packages"
    private val packagePattern =
        Regex("""[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+""")

    fun get(context: Context): Set<String> =
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .getStringSet(KEY_PACKAGES, emptySet())
            .orEmpty()
            .filterTo(sortedSetOf(), packagePattern::matches)

    fun set(context: Context, raw: String): Set<String> {
        val packages = parse(raw)
            .filterNotTo(sortedSetOf()) { it == context.packageName }
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .edit { putStringSet(KEY_PACKAGES, packages) }
        return packages
    }

    fun isAllowed(context: Context, packageName: String): Boolean =
        packageName != context.packageName && packageName in get(context)

    fun parse(raw: String): Set<String> =
        raw.split(Regex("""[\s,;]+"""))
            .asSequence()
            .map(String::trim)
            .filter(String::isNotEmpty)
            .filter(packagePattern::matches)
            .toSortedSet()
}
