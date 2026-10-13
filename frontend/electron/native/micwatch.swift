// micwatch — prints a JSON array of the processes currently capturing from an audio input device,
// e.g. [{"pid":812,"bundleId":"com.google.Chrome.helper","path":"/Applications/Google Chrome.app/…"}].
// Uses CoreAudio's process objects (macOS 14.2+). On older systems it prints []. Read-only: it never
// opens a device or touches audio data — it only asks CoreAudio which processes are recording.
import AppKit
import CoreAudio
import Darwin
import Foundation

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func processObjects() -> [AudioObjectID] {
    let system = AudioObjectID(kAudioObjectSystemObject)
    var addr = address(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.stride)
    guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

func isRunningInput(_ obj: AudioObjectID) -> Bool {
    var addr = address(kAudioProcessPropertyIsRunningInput)
    var value: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &value) == noErr && value != 0
}

func processID(_ obj: AudioObjectID) -> pid_t? {
    var addr = address(kAudioProcessPropertyPID)
    var value: pid_t = 0
    var size = UInt32(MemoryLayout<pid_t>.size)
    return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

func bundleID(_ obj: AudioObjectID) -> String? {
    var addr = address(kAudioProcessPropertyBundleID)
    var value: Unmanaged<CFString>? = nil
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &value) == noErr, let v = value else { return nil }
    return v.takeRetainedValue() as String
}

func executablePath(_ pid: pid_t) -> String? {
    var buf = [CChar](repeating: 0, count: 4096)
    return proc_pidpath(pid, &buf, UInt32(buf.count)) > 0 ? String(cString: buf) : nil
}

var out: [[String: Any]] = []
for obj in processObjects() where isRunningInput(obj) {
    var row: [String: Any] = [:]
    if let pid = processID(obj) {
        row["pid"] = Int(pid)
        if let p = executablePath(pid) { row["path"] = p }
    }
    if let b = bundleID(obj) {
        row["bundleId"] = b
        if row["path"] == nil, let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: b) { row["path"] = url.path }
    }
    if !row.isEmpty { out.append(row) }
}
let data = (try? JSONSerialization.data(withJSONObject: out)) ?? Data("[]".utf8)
FileHandle.standardOutput.write(data)
