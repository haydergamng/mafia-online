package com.haydergaming.mafia;
import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.content.Intent;
import android.net.Uri;
import android.view.ViewGroup;
public class MainActivity extends Activity {
 private WebView web;
 @Override public void onCreate(Bundle state) {
  super.onCreate(state);
  web = new WebView(this);
  web.setLayoutParams(new ViewGroup.LayoutParams(-1,-1));
  web.getSettings().setJavaScriptEnabled(true);
  web.getSettings().setDomStorageEnabled(true);
  web.setWebChromeClient(new WebChromeClient());
  web.setWebViewClient(new WebViewClient() {
   @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
    Uri uri=req.getUrl();
    if ("mafia-online-kfu6.onrender.com".equals(uri.getHost()) && "https".equals(uri.getScheme())) return false;
    if ("https".equals(uri.getScheme())) {
      startActivity(new Intent(Intent.ACTION_VIEW,uri)); return true;
    }
    return true;
   }
  });
  setContentView(web);
  web.loadUrl("https://mafia-online-kfu6.onrender.com/");
 }
 @Override public void onBackPressed() {
  if(web!=null && web.canGoBack()) web.goBack(); else super.onBackPressed();
 }
 @Override protected void onDestroy() { if(web!=null){web.destroy();web=null;} super.onDestroy(); }
}
