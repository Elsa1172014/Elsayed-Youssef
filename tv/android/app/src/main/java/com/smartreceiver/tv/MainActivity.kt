package com.smartreceiver.tv

import android.app.Activity
import android.os.Bundle
import android.view.KeyEvent
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.net.Uri

class MainActivity : Activity() {
    private lateinit var web: WebView
    private val home = "https://elsayed-youssef-vercel.vercel.app/"
    private val host = Uri.parse(home).host

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.settings.setSupportZoom(false)
        web.settings.builtInZoomControls = false
        web.isVerticalScrollBarEnabled = false
        web.isHorizontalScrollBarEnabled = false
        web.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        web.settings.allowFileAccess = false
        web.settings.allowContentAccess = false
        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                if (Uri.parse(url ?: "").host != host) return
                view?.evaluateJavascript(
                    "(function(){if(window.__tv)return;window.__tv=true;var s=document.createElement('style');s.textContent='button,a,input,select{min-height:56px;touch-action:manipulation}:focus-visible{outline:4px solid #38d9ff!important;outline-offset:3px!important;box-shadow:0 0 0 6px rgba(0,80,110,.45)!important;transform:scale(1.025);transition:outline .1s,transform .1s}html{scroll-behavior:smooth}';document.head.appendChild(s);document.addEventListener('keydown',function(e){var d={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(!d||/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;var a=[...document.querySelectorAll('button:not(:disabled),a[href],input,select')].filter(x=>x.getClientRects().length);if(!a.length)return;var p=document.activeElement;if(!a.includes(p)){a[0].focus();e.preventDefault();return}var r=p.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;var n=a.filter(x=>x!==p).map(x=>{var q=x.getBoundingClientRect(),dx=q.left+q.width/2-cx,dy=q.top+q.height/2-cy;return {x:x,forward:dx*d[0]+dy*d[1]>4,score:Math.abs(dx*d[0]+dy*d[1])+2*Math.abs(dx*d[1]+dy*d[0])}}).filter(x=>x.forward).sort((x,y)=>x.score-y.score)[0];if(n){n.x.focus();n.x.scrollIntoView({block:'nearest'});e.preventDefault()}})})();",
                    null
                )
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val uri = request?.url ?: return true
                return uri.scheme != "https" || uri.host != host
            }
        }
        web.isFocusable = true
        web.isFocusableInTouchMode = true
        setContentView(web)
        web.loadUrl(home)
        web.requestFocus()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (web.canGoBack()) web.goBack() else finish()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }
}
