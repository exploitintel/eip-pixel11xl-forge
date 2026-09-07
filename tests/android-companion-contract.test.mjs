import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Android companion exposes only the fixed hostctl authority", async () => {
  const [commands, client, activity, service, tile] = await Promise.all([
    source("android-app/app/src/main/java/com/exploitintel/forgecontrol/HostctlCommand.java"),
    source("android-app/app/src/main/java/com/exploitintel/forgecontrol/HostctlClient.java"),
    source("android-app/app/src/main/java/com/exploitintel/forgecontrol/MainActivity.java"),
    source("android-app/app/src/main/java/com/exploitintel/forgecontrol/ProtectionService.java"),
    source("android-app/app/src/main/java/com/exploitintel/forgecontrol/ForgeTileService.java"),
  ]);

  assert.match(client, /HOSTCTL_PATH = "\/data\/eip-cve-ops\/eip-hostctl\.sh"/);
  assert.match(client, /ROOT_TIMEOUT_BINARY = "\/system\/bin\/timeout"/);
  assert.match(client, /new ProcessBuilder\(\s*ROOT_BINARY,\s*"-c",\s*ROOT_TIMEOUT_BINARY/s);
  assert.match(client, /" -k 5s -s TERM "/);
  assert.match(client, /command\.rootTimeoutSeconds\(\)/);
  assert.match(client, /HOSTCTL_PATH[\s\S]*command\.verb\(\)/);
  assert.doesNotMatch(client, /Scanner|readLine|EditText|docker\.sock|\/data\/docker/);

  const verbs = [...commands.matchAll(/\b[A-Z_]+\("([a-z-]+)",\s*"[^"]+",\s*\d+,\s*\d+\)/g)]
    .map((match) => match[1]);
  assert.deepEqual(verbs, [
    "status",
    "start",
    "park",
    "park-when-idle",
    "cancel-park-when-idle",
    "reconcile",
    "logs",
  ]);
  assert.match(commands, /PARK_WHEN_IDLE\("park-when-idle", "Park when Forge is idle"/);
  assert.match(commands, /CANCEL_PARK_WHEN_IDLE\("cancel-park-when-idle", "Cancel pending park"/);
  assert.match(commands, /STATUS\("status", "Refresh status", 60, 70\)/);
  assert.match(commands, /START\("start", "Start Forge", 330, 360\)/);
  assert.match(commands, /LOGS\("logs", "Load recent host logs", 25, 30\)/);

  assert.doesNotMatch(activity, /hostctl\.execute\(command\)/);
  assert.match(activity, /ProtectionService\.dispatch\(this, command\)/);
  assert.match(
    activity,
    /status\.isKnownParked\(\) && !operationNowExists && cachedStateAllowsParked/,
  );
  assert.match(activity, /ProtectionService\.stopMonitoringIfNoOperation\(this\)/);
  assert.match(activity, /REFRESH_MILLIS = 60_000/);
  assert.match(activity, /OPERATION_REFRESH_MILLIS = 1_500/);
  assert.match(
    activity,
    /boolean operationBusy = operationDispatched[\s\S]*boolean actionBusy = logsInFlight\.get\(\) \|\| operationBusy/,
  );
  assert.doesNotMatch(activity, /boolean actionBusy =[^;]*statusInFlight/);
  assert.match(
    activity,
    /screen\.updateActions\(actions, operationBusy, statusInFlight\.get\(\), logsInFlight\.get\(\)\)/,
  );
  assert.match(
    activity,
    /ControlActions\.from\(lastStatus, actionBusy\)/,
  );
  assert.match(
    activity,
    /setMessage\(ProtectionService\.operationMessage\(this\)\);[\s\S]*scheduleOperationRefresh\(\);[\s\S]*return;/,
  );
  assert.doesNotMatch(
    activity,
    /operationDispatched = true;\s*monitorEnsured = false;\s*ensureMonitorStarted\(\)/,
  );
  assert.match(
    activity,
    /statusInFlight\.set\(false\);\s*if \(operationDispatched \|\| ProtectionService\.operationInProgress\(this\)\) \{[\s\S]*scheduleOperationRefresh\(\);[\s\S]*return;/,
  );
  assert.match(
    activity,
    /activityLifecycle\.destroy\(\);[\s\S]*mainHandler\.removeCallbacksAndMessages\(null\);[\s\S]*executor\.shutdownNow\(\)/,
  );
  assert.match(
    activity,
    /if \(!activityLifecycle\.permits\(lifecycleGeneration\)\) \{\s*return;\s*\}\s*mainHandler\.post\(\(\) -> \{\s*if \(!activityLifecycle\.permits\(lifecycleGeneration\)\)/,
  );
  assert.doesNotMatch(tile, /hostctl\.execute\(command\)/);
  assert.doesNotMatch(tile, /HostctlClient|hostctl\.execute/);
  assert.doesNotMatch(tile, /ProtectionService\.dispatch(?:Toggle)?\(/);
  assert.match(tile, /private void handleUnlockedClick\(\) \{[\s\S]*?openMainActivity\(\)/);
  assert.match(tile, /return "Tap to manage"/);
  assert.doesNotMatch(tile, /Tap to start|Tap to stop|Tap to park|Tap to cancel/);
  assert.match(service, /worker\.execute\(\(\) -> executeToggle\(operationToken\)\)/);
  assert.match(service, /worker\.execute\(\(\) -> executeAction\(command, operationToken\)\)/);
  assert.doesNotMatch(
    [activity, service, tile].join("\n"),
    /Stop after current|stop after work|Cancel pending stop|Tap to cancel stop/i,
  );
});

test("Android manifest keeps the companion local and declares protected FGS and tile boundaries", async () => {
  const manifest = await source("android-app/app/src/main/AndroidManifest.xml");

  assert.match(manifest, /android\.permission\.FOREGROUND_SERVICE_SPECIAL_USE/);
  assert.match(manifest, /android\.permission\.WAKE_LOCK/);
  assert.match(manifest, /android:foregroundServiceType="specialUse"/);
  assert.match(manifest, /android\.app\.PROPERTY_SPECIAL_USE_FGS_SUBTYPE/);
  assert.match(manifest, /android:permission="android\.permission\.BIND_QUICK_SETTINGS_TILE"/);
  assert.match(manifest, /android\.service\.quicksettings\.ACTIVE_TILE/);
  assert.match(manifest, /android:name="\.ProtectionService"[\s\S]*?android:exported="false"/);
  assert.match(manifest, /android:name="\.BootReceiver"[\s\S]*?android:exported="false"/);
  assert.doesNotMatch(manifest, /android\.permission\.INTERNET/);
  assert.doesNotMatch(manifest, /usesCleartextTraffic/);
});

test("CPU protection fails closed and the best-effort Wi-Fi request follows active transport", async () => {
  const service = await source(
    "android-app/app/src/main/java/com/exploitintel/forgecontrol/ProtectionService.java",
  );
  const lease = await source(
    "android-app/app/src/main/java/com/exploitintel/forgecontrol/OperationLease.java",
  );
  const coordinator = await source(
    "android-app/app/src/main/java/com/exploitintel/forgecontrol/OperationCoordinator.java",
  );
  const lifecycle = await source(
    "android-app/app/src/main/java/com/exploitintel/forgecontrol/ServiceLifecycleGate.java",
  );
  const allJava = await Promise.all([
    source("android-app/app/src/main/java/com/exploitintel/forgecontrol/MainActivity.java"),
    source("android-app/app/src/main/java/com/exploitintel/forgecontrol/ProtectionService.java"),
    source("android-app/app/src/main/java/com/exploitintel/forgecontrol/ForgeTileService.java"),
    source("android-app/app/src/main/java/com/exploitintel/forgecontrol/BootReceiver.java"),
  ]);

  assert.match(service, /PowerManager\.PARTIAL_WAKE_LOCK/);
  assert.match(service, /capabilities\.hasTransport\(NetworkCapabilities\.TRANSPORT_WIFI\)/);
  assert.match(service, /boolean holdWifi = protectionRequired && wifiIsActive/);
  assert.match(service, /Wi-Fi behavior requires phone acceptance/);
  assert.match(service, /ForegroundServiceStartNotAllowedException/);
  assert.match(service, /command == null && !toggle \? 0 : POLL_SECONDS/);
  assert.match(service, /operationCoordinator\.beginPoll\(currentOperationToken\(this\)\)/);
  assert.match(service, /operationCoordinator\.mayRecover/);
  assert.match(service, /operationCoordinator\.isPollCurrent/);
  assert.match(service, /private void applyStatusIfCurrent/);
  assert.match(
    service,
    /synchronized \(OPERATION_GUARD\)[\s\S]*operationCoordinator\.isPollCurrent\(snapshot, markerToken\)/,
  );
  assert.match(service, /replaceOperation\(/);
  assert.match(service, /finishOperationWithStatus\(/);
  assert.match(
    service,
    /SharedPreferences\.Editor editor = preferences\.edit\(\)[\s\S]*\.putString\(PREF_OPERATION, ""\)[\s\S]*editor\.putString\(PREF_LAST_STATE, lastState\)[\s\S]*return editor\.commit\(\)/,
  );
  assert.match(service, /Recovered authoritative host state after service restart/);
  assert.match(lease, /STALE_MILLIS = 8 \* 60_000/);
  assert.match(service, /Cleared a stale app operation marker/);
  assert.match(service, /status\.hasKnownStartTime\(\)/);
  assert.match(coordinator, /snapshot\.generation == generation/);
  assert.match(coordinator, /snapshot\.markerToken\.equals\(clean\(currentMarkerToken\)\)/);
  assert.match(service, /lifecycle\.beginStopping\(\);[\s\S]*worker\.shutdownNow\(\)/);
  assert.match(service, /if \(!lifecycle\.permitsWork\(\)\) \{\s*return;\s*\}/);
  assert.match(lifecycle, /synchronized boolean runIfActive/);
  assert.match(service, /lifecycle\.runIfActive\(\(\) -> \{/);
  assert.match(allJava[2], /if \(isLocked\(\)\)/);
  assert.match(allJava[2], /unlockAndRun\(this::handleUnlockedClick\)/);
  assert.doesNotMatch(allJava.join("\n"), /stay_on_while_plugged_in|iptables|nft|ip rule|ip route|setWifiEnabled/);
});

test("offline and Gradle debug builds share one ignored signing identity", async () => {
  const [buildScript, gradle, ignore, building] = await Promise.all([
    source("android-app/tools/build-offline.sh"),
    source("android-app/app/build.gradle"),
    source(".gitignore"),
    source("android-app/BUILDING.md"),
  ]);

  const keyPath = ".signing/forge-control-debug.jks";
  assert.match(buildScript, new RegExp(keyPath.replaceAll(".", "\\.")));
  assert.match(gradle, new RegExp(keyPath.replaceAll(".", "\\.")));
  assert.match(ignore, /\*\.jks/);
  assert.match(building, /build\/offline\/forge-control-debug\.apk/);
});
