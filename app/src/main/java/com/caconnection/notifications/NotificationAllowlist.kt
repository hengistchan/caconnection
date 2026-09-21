package com.caconnection.notifications

import android.content.Context
import androidx.core.content.edit

object NotificationAllowlist {
    private const val PREFERENCES = "notification_capture"
    private const val KEY_PACKAGES = "allowed_packages"
    private const val KEY_DEFAULTS_VERSION = "recommended_defaults_version"
    private const val RECOMMENDED_DEFAULTS_VERSION = 2
    internal val RECOMMENDED_PACKAGES = sortedSetOf("com.android.mms")
    private const val FEISHU_PACKAGE_PREFIX = "com.ss.android.lark"
    private val packagePattern =
        Regex("""[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+""")

    fun get(context: Context): Set<String> =
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .getStringSet(KEY_PACKAGES, emptySet())
            .orEmpty()
            .filterTo(sortedSetOf()) {
                packagePattern.matches(it) && !isWebhookLoopSource(it)
            }

    fun ensureRecommendedDefaults(context: Context): Set<String> {
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        if (preferences.getInt(KEY_DEFAULTS_VERSION, 0) >= RECOMMENDED_DEFAULTS_VERSION) {
            return get(context)
        }
        val packages = mergeRecommended(get(context))
        preferences.edit {
            putStringSet(KEY_PACKAGES, packages)
            putInt(KEY_DEFAULTS_VERSION, RECOMMENDED_DEFAULTS_VERSION)
        }
        return packages
    }

    internal fun mergeRecommended(current: Set<String>): Set<String> =
        (current + RECOMMENDED_PACKAGES)
            .filterNotTo(sortedSetOf(), ::isWebhookLoopSource)

    fun set(context: Context, raw: String): Set<String> {
        val packages = parse(raw)
            .filterNotTo(sortedSetOf()) { it == context.packageName }
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .edit { putStringSet(KEY_PACKAGES, packages) }
        return packages
    }

    /**
     * Add a single package to the allowlist.
     * Returns the updated set of allowed packages.
     */
    fun addPackage(context: Context, packageName: String): Set<String> {
        if (
            packageName == context.packageName ||
            !packagePattern.matches(packageName) ||
            isWebhookLoopSource(packageName)
        ) {
            return get(context)
        }
        val current = get(context).toMutableSet()
        current.add(packageName)
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .edit { putStringSet(KEY_PACKAGES, current) }
        return current.toSortedSet()
    }

    /**
     * Remove a single package from the allowlist.
     * Returns the updated set of allowed packages.
     */
    fun removePackage(context: Context, packageName: String): Set<String> {
        val current = get(context).toMutableSet()
        current.remove(packageName)
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .edit { putStringSet(KEY_PACKAGES, current) }
        return current.toSortedSet()
    }

    /**
     * Set a single package (replace all existing with this one).
     * Returns the updated set containing only the specified package.
     */
    fun setSingle(context: Context, packageName: String): Set<String> {
        if (
            packageName == context.packageName ||
            !packagePattern.matches(packageName) ||
            isWebhookLoopSource(packageName)
        ) {
            return get(context)
        }
        val packages = sortedSetOf(packageName)
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
            .filterNot(::isWebhookLoopSource)
            .toSortedSet()

    internal fun isWebhookLoopSource(packageName: String): Boolean =
        packageName == FEISHU_PACKAGE_PREFIX ||
            packageName.startsWith("$FEISHU_PACKAGE_PREFIX.")
}
