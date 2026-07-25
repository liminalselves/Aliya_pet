package com.miqi.aliyapet.glass;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

@SuppressWarnings("deprecation")
public class MainActivity extends Activity {
    private static final int OVERLAY_REQUEST = 1001;
    private static final int NOTIFICATION_REQUEST = 1002;
    private static final String PREFS = "aliya_pet_settings";

    private WebView webView;
    private String pendingAction = PetOverlayService.ACTION_START;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        applySystemTheme(getCharacter());
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setMediaPlaybackRequiresUserGesture(true);

        webView.setBackgroundColor(Color.TRANSPARENT);
        webView.addJavascriptInterface(new PetBridge(), "AliyaNative");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !request.getUrl().toString().startsWith("file:///android_asset/www/");
            }
        });
        webView.loadUrl("file:///android_asset/www/index.html");
        setContentView(webView);
    }

    private class PetBridge {
        @JavascriptInterface
        public String getCharacter() {
            return MainActivity.this.getCharacter();
        }

        @JavascriptInterface
        public boolean isRunning() {
            return PetOverlayService.isRunning();
        }

        @JavascriptInterface
        public void setRunning(boolean running) {
            runOnUiThread(() -> {
                if (running) {
                    startPet(PetOverlayService.ACTION_START);
                } else {
                    stopService(new Intent(MainActivity.this, PetOverlayService.class));
                    emitRunning(false);
                }
            });
        }

        @JavascriptInterface
        public void setCharacter(String character) {
            String normalized = normalizeCharacter(character);
            getSharedPreferences(PREFS, MODE_PRIVATE)
                    .edit()
                    .putString("character", normalized)
                    .apply();
            runOnUiThread(() -> {
                applySystemTheme(normalized);
                if (PetOverlayService.isRunning()) {
                    sendServiceAction(PetOverlayService.ACTION_SET_CHARACTER);
                }
            });
        }

        @JavascriptInterface
        public void performAction(String action) {
            String nativeAction;
            switch (action) {
                case "random":
                    nativeAction = PetOverlayService.ACTION_RANDOM;
                    break;
                case "auto":
                    nativeAction = PetOverlayService.ACTION_TOGGLE_AUTO;
                    break;
                case "mirror":
                    nativeAction = PetOverlayService.ACTION_TOGGLE_MIRROR;
                    break;
                case "reset":
                    nativeAction = PetOverlayService.ACTION_RESET;
                    break;
                default:
                    return;
            }
            runOnUiThread(() -> startPet(nativeAction));
        }
    }

    private void startPet(String action) {
        pendingAction = action;
        if (!Settings.canDrawOverlays(this)) {
            Intent intent = new Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getPackageName()));
            startActivityForResult(intent, OVERLAY_REQUEST);
            return;
        }

        requestNotificationPermissionIfNeeded();
        sendServiceAction(action);
        emitRunning(true);
    }

    private void sendServiceAction(String action) {
        Intent intent = new Intent(this, PetOverlayService.class);
        intent.setAction(action);
        startForegroundService(intent);
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                    new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    NOTIFICATION_REQUEST);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != OVERLAY_REQUEST) {
            return;
        }
        if (Settings.canDrawOverlays(this)) {
            startPet(pendingAction);
        } else {
            emitRunning(false);
        }
    }

    private String getCharacter() {
        SharedPreferences preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        return normalizeCharacter(
                preferences.getString("character", PetOverlayService.CHARACTER_ALIYA));
    }

    private String normalizeCharacter(String character) {
        return PetOverlayService.CHARACTER_WINDY.equals(character)
                ? PetOverlayService.CHARACTER_WINDY
                : PetOverlayService.CHARACTER_ALIYA;
    }

    private void applySystemTheme(String character) {
        int color = PetOverlayService.CHARACTER_WINDY.equals(character)
                ? Color.rgb(246, 226, 193)
                : Color.rgb(154, 137, 192);
        getWindow().setStatusBarColor(color);
        getWindow().setNavigationBarColor(color);
    }

    private void emitRunning(boolean running) {
        webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('pet-running',{detail:"
                        + running + "}))",
                null);
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        webView.destroy();
        super.onDestroy();
    }
}
