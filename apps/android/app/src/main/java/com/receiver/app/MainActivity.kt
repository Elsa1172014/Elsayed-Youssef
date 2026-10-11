package com.receiver.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView

class MainActivity : ComponentActivity() {
    private val api = Api(BuildConfig.API_BASE)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MaterialTheme { App(api) } }
    }
}

@Composable
fun App(api: Api) {
    var signedIn by remember { mutableStateOf(false) }
    if (!signedIn) SignIn(api) { signedIn = true } else Channels(api)
}

@Composable
fun SignIn(api: Api, onDone: () -> Unit) {
    var user by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize().padding(24.dp)) {
        OutlinedTextField(user, { user = it }, label = { Text("Username") }, singleLine = true)
        OutlinedTextField(pass, { pass = it }, label = { Text("Password") }, singleLine = true, visualTransformation = PasswordVisualTransformation())
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(onClick = { scope.launch { runCatching { api.login(user, pass) }.onSuccess { onDone() }.onFailure { error = it.message } } }) { Text("Sign in") }
        // Account creation is available on the web app until the mobile sign-up screen is added.
    }
}

@Composable
fun Channels(api: Api) {
    var channels by remember { mutableStateOf<List<Channel>>(emptyList()) }
    var selected by remember { mutableStateOf<Channel?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        runCatching { api.channels() }.onSuccess { channels = it }.onFailure { error = it.message }
    }

    Column(Modifier.fillMaxSize()) {
        selected?.let { PlayerPane(api, it) }
        error?.let { Text(it, Modifier.padding(16.dp), color = MaterialTheme.colorScheme.error) }
        LazyColumn(Modifier.fillMaxSize()) {
            items(channels, key = { it.id }) { c ->
                Text(
                    c.name + (c.group?.let { " · $it" } ?: ""),
                    Modifier.fillMaxWidth().clickable { selected = c }.padding(16.dp), // focusable via D-pad on TV
                )
            }
        }
    }
}

@Composable
fun PlayerPane(api: Api, channel: Channel) {
    val context = LocalContext.current
    val player = remember { ExoPlayer.Builder(context).build() }
    LaunchedEffect(channel.id) {
        runCatching { api.streamUrl(channel.id) }.onSuccess {
            player.setMediaItem(MediaItem.fromUri(it))
            player.prepare()
            player.playWhenReady = true
        }
    }
    DisposableEffect(Unit) { onDispose { player.release() } }
    AndroidView(factory = { PlayerView(it).apply { this.player = player } }, modifier = Modifier.fillMaxWidth().height(240.dp))
}
