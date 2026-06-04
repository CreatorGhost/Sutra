package app.sutra.memory;

import android.content.Context;
import android.content.Intent;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** JS bridge to start/stop the microphone foreground service and pin the capture route. */
@CapacitorPlugin(name = "ForegroundMic")
public class ForegroundMicPlugin extends Plugin {
    @PluginMethod
    public void start(PluginCall call) {
        Intent i = new Intent(getContext(), MicForegroundService.class);
        if (Build.VERSION.SDK_INT >= 26) {
            getContext().startForegroundService(i);
        } else {
            getContext().startService(i);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), MicForegroundService.class));
        call.resolve();
    }

    /**
     * Pin audio capture to the BUILT-IN mic so Chromium's WebRTC capture does not select a
     * Bluetooth HFP/SCO "communication" device (e.g. a paired watch or carkit). Those devices are
     * flagged preferred-microphone-for-calls, but the SCO link can't be realized in the WebView,
     * so Chromium fails with "Unable to select communication device" and getUserMedia rejects with
     * NotReadableError. Forcing the built-in mic (the same device the native recorder uses) makes
     * device selection succeed. Best-effort: never throws to JS.
     */
    @PluginMethod
    public void routeToBuiltinMic(PluginCall call) {
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                if (Build.VERSION.SDK_INT >= 31) {
                    am.clearCommunicationDevice();
                    for (AudioDeviceInfo d : am.getAvailableCommunicationDevices()) {
                        if (d.getType() == AudioDeviceInfo.TYPE_BUILTIN_MIC) {
                            am.setCommunicationDevice(d);
                            break;
                        }
                    }
                } else {
                    am.setMode(AudioManager.MODE_NORMAL);
                    am.stopBluetoothSco();
                    am.setBluetoothScoOn(false);
                }
            }
        } catch (Exception e) {
            // best-effort; leave the route as-is
        }
        call.resolve();
    }
}
