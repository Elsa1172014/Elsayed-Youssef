package com.receiver.app

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.net.HttpURLConnection
import java.net.URL

@Serializable
data class Channel(
    val id: String,
    val name: String,
    val group: String? = null,
    val hidden: Boolean = false,
)

@Serializable
private data class StreamResponse(val url: String)

/** Thin client for the Smart Receiver API. The dev token scheme is a placeholder until real auth lands. */
class Api(private val base: String, private val token: String) {
    private val json = Json { ignoreUnknownKeys = true }

    private suspend fun get(path: String): String = withContext(Dispatchers.IO) {
        val conn = URL(base + path).openConnection() as HttpURLConnection
        conn.setRequestProperty("authorization", "Bearer $token")
        conn.connectTimeout = 10_000
        conn.readTimeout = 15_000
        try {
            if (conn.responseCode !in 200..299) error("HTTP ${conn.responseCode}")
            conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    suspend fun channels(): List<Channel> =
        json.decodeFromString<List<Channel>>(get("/v1/me/channels")).filterNot { it.hidden }

    /** Playable URL; the client then streams directly from the origin (the backend never proxies media). */
    suspend fun streamUrl(channelId: String): String =
        json.decodeFromString<StreamResponse>(get("/v1/me/channels/$channelId/stream")).url
}
