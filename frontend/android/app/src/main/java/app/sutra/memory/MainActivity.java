package app.sutra.memory;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ForegroundMicPlugin.class);
        super.onCreate(savedInstanceState);

        // (1) OS-level runtime permissions. RECORD_AUDIO is a "dangerous" permission and is NOT
        // granted at install time — without it, in-page getUserMedia() throws NotAllowedError even
        // when the WebView gate (below) is open. POST_NOTIFICATIONS (Android 13+) is needed so the
        // capture foreground service can show its "Sutra is listening" notification.
        List<String> need = new ArrayList<>();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.RECORD_AUDIO);
        }
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!need.isEmpty()) {
            ActivityCompat.requestPermissions(this, need.toArray(new String[0]), 4711);
        }

        // (2) The Capacitor WebView keeps its OWN per-origin media gate, separate from the OS grant
        // above. Without granting the WebView's permission request, getUserMedia() is rejected and
        // the AudioContext can't open the mic. Our content is first-party (localhost), so grant it.
        this.bridge.getWebView().setWebChromeClient(new BridgeWebChromeClient(this.bridge) {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> request.grant(request.getResources()));
            }
        });
    }
}
