package com.caconnection.telephony.inbound

import android.content.Intent
import android.os.Bundle

object IntentExtrasInspector {
    @Suppress("DEPRECATION")
    fun asMap(intent: Intent): Map<String, Any?> {
        val extras = intent.extras ?: return emptyMap()
        return extras.keySet().associateWith { key -> extras.get(key) }
    }

    fun describe(extras: Map<String, Any?>): String {
        if (extras.isEmpty()) return "(no extras)"
        return extras.toSortedMap().entries.joinToString("\n") { (key, value) ->
            "$key  ${typeAndSafeValue(value)}"
        }
    }

    private fun typeAndSafeValue(value: Any?): String = when (value) {
        null -> "null"
        is String -> "String=${value.take(120)}"
        is Int, is Long, is Short, is Boolean, is Float, is Double -> "${value.javaClass.simpleName}=$value"
        is ByteArray -> "ByteArray(size=${value.size})"
        is Array<*> -> "Array(size=${value.size}, type=${value.javaClass.componentType?.simpleName})"
        is Bundle -> "Bundle(keys=${value.keySet().sorted().joinToString()})"
        else -> value.javaClass.name
    }
}
