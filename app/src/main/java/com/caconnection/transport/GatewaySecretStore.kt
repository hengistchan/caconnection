package com.caconnection.transport

import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object GatewaySecretStore {
    private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
    private const val KEY_ALIAS = "caconnection.gateway.transport.v1"
    private const val KEY_CIPHERTEXT = "shared_secret_ciphertext_base64"
    private const val KEY_NONCE = "shared_secret_nonce_base64"
    private const val LEGACY_PLAINTEXT_KEY = "shared_secret_base64"

    fun loadAndMigrate(
        preferences: SharedPreferences
    ): String {
        val ciphertext = preferences.getString(KEY_CIPHERTEXT, "").orEmpty()
        val nonce = preferences.getString(KEY_NONCE, "").orEmpty()
        if (ciphertext.isNotBlank() && nonce.isNotBlank()) {
            return runCatching { decrypt(ciphertext, nonce) }.getOrDefault("")
        }
        val legacy = preferences.getString(LEGACY_PLAINTEXT_KEY, "").orEmpty()
        if (legacy.isBlank()) return ""
        return runCatching {
            store(preferences, legacy)
            legacy
        }.getOrDefault("")
    }

    fun store(
        preferences: SharedPreferences,
        secretBase64: String
    ) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val ciphertext = cipher.doFinal(secretBase64.toByteArray(Charsets.UTF_8))
        preferences.edit()
            .putString(
                KEY_CIPHERTEXT,
                Base64.getEncoder().encodeToString(ciphertext)
            )
            .putString(
                KEY_NONCE,
                Base64.getEncoder().encodeToString(cipher.iv)
            )
            .remove(LEGACY_PLAINTEXT_KEY)
            .apply()
    }

    private fun decrypt(ciphertextBase64: String, nonceBase64: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            getOrCreateKey(),
            GCMParameterSpec(
                128,
                Base64.getDecoder().decode(nonceBase64)
            )
        )
        return cipher.doFinal(
            Base64.getDecoder().decode(ciphertextBase64)
        ).toString(Charsets.UTF_8)
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply {
            load(null)
        }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            KEYSTORE_PROVIDER
        ).apply {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or
                        KeyProperties.PURPOSE_DECRYPT
                )
                    .setKeySize(256)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(
                        KeyProperties.ENCRYPTION_PADDING_NONE
                    )
                    .setRandomizedEncryptionRequired(true)
                    .build()
            )
        }.generateKey()
    }
}
