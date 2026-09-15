package com.caconnection.transport

import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Base64
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager

object GatewayTls {
    fun socketFactory(certificatePinSha256Base64: String): SSLSocketFactory? =
        certificatePinSha256Base64
            .takeIf(String::isNotBlank)
            ?.let { pinnedContext(it).socketFactory }

    private fun pinnedContext(pin: String): SSLContext {
        val expectedPin = Base64.getDecoder().decode(pin)
        val trustManager = object : X509TrustManager {
            override fun checkClientTrusted(
                chain: Array<out X509Certificate>?,
                authType: String?
            ) = throw CertificateException("Client certificates are not accepted")

            override fun checkServerTrusted(
                chain: Array<out X509Certificate>?,
                authType: String?
            ) {
                val certificate = chain?.firstOrNull()
                    ?: throw CertificateException("Missing server certificate")
                certificate.checkValidity()
                val actualPin = MessageDigest.getInstance("SHA-256")
                    .digest(certificate.encoded)
                if (!MessageDigest.isEqual(expectedPin, actualPin)) {
                    throw CertificateException("Server certificate pin mismatch")
                }
            }

            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        return SSLContext.getInstance("TLS").apply {
            init(null, arrayOf(trustManager), null)
        }
    }
}
