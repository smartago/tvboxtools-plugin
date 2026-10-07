#!/usr/bin/env node
// TV Box Tools MCP server + CLI (Apache-2.0) — built from https://github.com/smartago/tvboxtools by apps/cli/scripts/build-plugin.mjs.
// Third-party modules load from ./node_modules, copied unchanged from their npm releases.

// apps/cli/src/main.ts
import { writeFile as writeFile3 } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// packages/adb/src/mock.ts
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var MockTransport = class {
  kind = "mock";
  supports = ["usb", "tcp", "wireless"];
  o;
  /** Mutable box state shared by every device this transport hands out. */
  box;
  constructor(o = {}) {
    this.o = { scenario: "happy", box: "xiaomi", speed: 1, launcherPackage: "com.hotel.bnb.smart.hospitality.tv.launcher", self: false, ...o };
    this.box = new MockBoxState(this.o);
  }
  wait(ms) {
    return this.o.speed ? sleep(ms * this.o.speed) : Promise.resolve();
  }
  devices(paths = this.supports) {
    const list = [];
    if (paths.includes("usb")) list.push({ id: "7F3A9C12B04E", name: "Xiaomi Mi Box S", addr: "USB \xB7 7F3A9C12B04E", method: "usb" });
    const gtv = { id: "192.168.1.73:5555", name: "Chromecast with Google TV", addr: "192.168.1.73:5555", method: "wireless", tls: true };
    const mi = { id: "192.168.1.50:5555", name: "Xiaomi Mi Box S \xB7 MIBOX4", addr: "192.168.1.50:5555", method: "tcp" };
    const net = this.o.box === "googletv" ? [gtv, mi] : [mi, gtv];
    for (const d of net) if (paths.includes(d.method)) list.push(d);
    if (this.o.self && paths.includes("tcp")) {
      list.unshift({ id: "10.0.2.15:5555", name: this.box.props["ro.product.model"] ?? "This box", addr: "10.0.2.15:5555", method: "tcp", self: true });
    }
    return list;
  }
  async discover(opts = {}) {
    await this.wait(1800);
    if (opts.signal?.aborted) return [];
    if (this.o.scenario === "nodevices") throw new NoDevicesError(opts.paths?.includes("usb") && opts.paths.length === 1 ? "usb-driver" : "client-isolation");
    const list = this.devices(opts.paths ?? this.supports);
    for (const d of list) opts.onFound?.(d);
    return list;
  }
  /** Stands in for Chrome's chooser: one device, as if the person had granted it. */
  async pick() {
    await this.wait(600);
    return this.devices(["usb"])[0] ?? null;
  }
  async connect(target, opts = {}) {
    const info = typeof target === "string" ? { id: target, name: target, addr: target, method: "tcp" } : target;
    let attempt = 0;
    if (this.o.scenario === "silent") {
      await this.wait(1500);
      if (opts.signal?.aborted) throw new Error("aborted");
      throw new Error(`connect ${info.addr}: ETIMEDOUT \u2014 no answer after 5000 ms`);
    }
    for (; ; ) {
      attempt++;
      await this.wait(1500);
      if (opts.signal?.aborted) throw new Error("aborted");
      const ok2 = this.o.scenario !== "unauthorized" && attempt >= 3;
      if (ok2) break;
      opts.onUnauthorized?.(attempt);
      if (!opts.waitForAuth) throw new UnauthorizedError(attempt);
      if (attempt >= 40) throw new UnauthorizedError(attempt);
    }
    return new MockDevice(info, this.box, this.wait.bind(this));
  }
  async pair(_hostPort, code) {
    await this.wait(800);
    if (!/^\d{6}$/.test(code)) throw new Error("pairing failed: wrong code");
  }
};
var MockBoxState = class {
  constructor(o) {
    this.o = o;
    this.accounts = o.scenario === "accounts" ? ["someone@gmail.com"] : [];
    this.stock = o.box === "googletv" ? "com.google.android.apps.tv.launcherx" : o.box === "firetv" ? "com.amazon.tv.launcher" : o.box === "other" ? "com.droidlogic.mboxlauncher" : "com.google.android.tvlauncher";
    this.packages = new Map([
      [this.stock, 1],
      ["com.android.settings", 1],
      // What a television actually has in it. Three packages made every list on every page look
      // empty; this is the ordinary bag an Android TV box ships with, so the Debloat judgement, the
      // backup list and the free-space page can be walked without a box in hand.
      ["com.google.android.youtube.tv", 1],
      ["com.google.android.katniss", 1],
      ["com.google.android.apps.mediashell", 1],
      ["com.google.android.tvrecommendations", 1],
      ["com.google.android.backdrop", 1],
      ["com.google.android.tts", 1],
      ["com.google.android.videos", 1],
      ["com.google.android.play.games", 1],
      ["com.netflix.ninja", 1],
      ["com.spotify.tv.android", 1],
      ...this.o.box === "xiaomi" ? [
        ["com.xiaomi.mitv.tvrecommendation", 1],
        ["com.xiaomi.mitv.smartshare", 1],
        ["com.xiaomi.mitv.payment", 1]
      ] : [],
      ...this.o.box === "other" ? [
        // Ο δεύτερος: εγκατεστημένος, μπορεί να είναι HOME, δεν τον κρατά.
        ["com.android.launcher", 1]
      ] : [],
      ...this.o.box === "firetv" ? [
        ["com.amazon.venezia", 1],
        ["com.amazon.tv.forcedotaupdater.v2", 1],
        ["com.amazon.tv.alexadetection", 1]
      ] : []
    ]);
    this.home = `${this.stock}/.MainActivity`;
  }
  o;
  accounts;
  packages;
  home;
  deviceOwner = null;
  adbEnabled = true;
  appops = [];
  grants = [];
  secure = {};
  /** `settings put global|system` — the Screen page writes font_scale, the clock reads ntp_server */
  settings = {};
  /** what `wm size` / `wm density` answer: the panel, and the override on top of it (null = none) */
  sizeOverride = null;
  densityOverride = null;
  /**
   * ΟΣΑ ΗΡΘΑΝ ΜΕ SIDELOAD ΚΑΙ ΜΠΟΡΟΥΝ ΝΑ ΕΙΝΑΙ HOME (3/10/2026). Χωρίς αυτό, ένα APK που
   * εγκαθίστατο δεν εμφανιζόταν ΠΟΤΕ στη λίστα των launcher, και η διαδρομή «Άλλος launcher»
   * δεν δοκιμαζόταν ποτέ ως το τέλος — ακριβώς εκεί που ο Jim βρήκε δύο bug.
   */
  sideloaded = [];
  broadcasts = [];
  disabled = [];
  stock;
  /**
   * What the panel IS, before any override. The two newer boxes of the set are 4K and the two old
   * ones are 1080p — which is the whole point of the Screen page: the 4K box is the one that gets
   * quicker when it is told to draw 1080p.
   */
  get physicalSize() {
    return this.o.box === "googletv" || this.o.box === "androidtv" ? "3840x2160" : "1920x1080";
  }
  get physicalDensity() {
    return this.o.box === "googletv" || this.o.box === "androidtv" ? 640 : 320;
  }
  get props() {
    const byBox = {
      googletv: { model: "Chromecast", manufacturer: "Google", brand: "google", device: "sabrina", release: "12", sdk: "31" },
      androidtv: { model: "ADT-3", manufacturer: "Askey", brand: "Android", device: "adt3", release: "11", sdk: "30" },
      xiaomi: { model: "MIBOX4", manufacturer: "Xiaomi", brand: "Xiaomi", device: "once", release: "9", sdk: "28" },
      other: { model: "X96 Max", manufacturer: "Amlogic", brand: "Amlogic", device: "p212", release: "9", sdk: "28" },
      firetv: { model: "AFTKA", manufacturer: "Amazon", brand: "Amazon", device: "kara", release: "9", sdk: "28" }
    }[this.o.box];
    return {
      "ro.product.model": byBox.model,
      "ro.product.manufacturer": byBox.manufacturer,
      "ro.product.brand": byBox.brand,
      "ro.product.device": byBox.device,
      "ro.serialno": "7F3A9C12B04E",
      "ro.build.version.release": byBox.release,
      "ro.build.version.sdk": byBox.sdk,
      "ro.build.characteristics": "tv"
    };
  }
  /** A small, faithful `adb shell` for the commands the tool actually uses. */
  run(cmd) {
    const c = cmd.trim().replace(/\s+/g, " ");
    const a = c.split(" ");
    if (c === "getprop") return Object.entries(this.props).map(([k, v]) => `[${k}]: [${v}]`).join("\n") + "\n";
    if (a[0] === "getprop" && a[1]) return (this.props[a[1]] ?? "") + "\n";
    if (c === "dumpsys account") return `User UserInfo{0:Owner:c13}:
  Accounts: ${this.accounts.length}
${this.accounts.map((n) => `    Account {name=${n}, type=com.google}`).join("\n")}
`;
    if (c.startsWith("df")) return "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/dm-0 5806852 2214436 3576032 39% /data\n";
    if (c.startsWith("pm list packages")) {
      const preinstalled = /^(com\.google\.|com\.android\.|com\.xiaomi\.|com\.mitv\.|com\.amazon\.|android$)/;
      let list = [...this.packages].filter(([p]) => c.includes(" -d") ? this.disabled.includes(p) : true);
      if (c.includes(" -3")) list = list.filter(([p]) => !preinstalled.test(p) && p !== this.stock);
      if (c.includes(" -e")) list = list.filter(([p]) => !this.disabled.includes(p));
      return list.map(([p, v]) => `package:${p}${c.includes("--show-versioncode") && v !== null ? ` versionCode:${v}` : ""}`).join("\n") + "\n";
    }
    if (c === "settings get global development_settings_enabled") return "1\n";
    if (c === "settings get global adb_enabled") return `${this.adbEnabled ? 1 : 0}
`;
    if (a[0] === "settings" && a[1] === "get" && a[3]) return (this.settings[`${a[2]}.${a[3]}`] ?? "null") + "\n";
    if (a[0] === "settings" && a[1] === "put" && (a[2] === "global" || a[2] === "system") && a[3] && c !== "settings put global adb_enabled 0") {
      this.settings[`${a[2]}.${a[3]}`] = a.slice(4).join(" ");
      return "";
    }
    if (c.startsWith("settings put secure ")) {
      this.secure[a[3]] = a.slice(4).join(" ");
      return "";
    }
    if (c === "settings put global adb_enabled 0") {
      this.adbEnabled = false;
      return "";
    }
    if (c.startsWith("cmd package resolve-activity")) {
      if (!c.includes("-a android.intent.action.MAIN")) return "No activity found\n";
      const [pkg2, cls] = this.home.split("/");
      return `${pkg2}/${cls?.startsWith(".") ? pkg2 + cls : cls}
`;
    }
    if (c.startsWith("cmd package query-activities") && c.includes("LEANBACK_LAUNCHER")) {
      const tv = [this.o.launcherPackage, this.stock].filter((p) => this.packages.has(p) && p !== "com.android.launcher");
      return tv.map((p) => `${p}/.Launcher`).join("\n") + "\n";
    }
    if (c.startsWith("cmd package query-activities")) {
      const homes = [.../* @__PURE__ */ new Set([this.stock, this.home.split("/")[0], "com.android.launcher", ...this.sideloaded])].filter((p) => this.packages.has(p));
      return homes.map((p) => `  Activity #0:
      name=${p}.MainActivity
      packageName=${p}`).join("\n") + "\n";
    }
    if (c.startsWith("cmd package set-home-activity ")) {
      const comp = a[3];
      const pkg2 = comp.split("/")[0];
      if (!this.packages.has(pkg2)) return `Error: Component ${comp} not found
`;
      this.home = comp;
      return "";
    }
    if (a[0] === "dumpsys" && a[1] === "package" && a[2]) {
      if (!this.packages.has(a[2])) return `Unable to find package: ${a[2]}
`;
      const play = !/^com\.(viggo|smarthoteltv|zonesage)/.test(a[2]);
      return `Packages:
  Package [${a[2]}]:
    versionName=${this.packages.get(a[2]) === null ? "1.0" : "3.4.2"}
    installerPackageName=${play ? "com.android.vending" : "null"}
    firstInstallTime=2026-08-14 21:03:11
`;
    }
    if (c === "dumpsys device_policy") return this.deviceOwner ? `Current Device Policy Manager state:
  Device Owner: 
    admin=ComponentInfo{${this.deviceOwner}}
` : "Current Device Policy Manager state:\n  Enabled Device Admins (User 0, provisioningState: 0):\n";
    if (c.startsWith("dpm set-device-owner ")) {
      const pkg2 = a[2].split("/")[0];
      if (!this.packages.has(pkg2)) return `java.lang.IllegalArgumentException: Unknown admin: ComponentInfo{${a[2]}}
`;
      if (this.accounts.length) return "java.lang.IllegalStateException: Not allowed to set the device owner because there are already some accounts on the device\n";
      this.deviceOwner = a[2];
      return `Success: Device owner set to package ComponentInfo{${a[2]}}
Active admin set to component {${a[2]}}
`;
    }
    if (c.startsWith("appops set ")) {
      this.appops.push(`${a[2]} ${a[3]}`);
      return "";
    }
    if (c.startsWith("pm grant ")) {
      this.grants.push(`${a[2]} ${a[3]}`);
      return "";
    }
    if (c.startsWith("cmd notification allow_listener ")) return "";
    if (c.startsWith("am broadcast ")) {
      this.broadcasts.push(c);
      return "Broadcasting: Intent { \u2026 }\nBroadcast completed: result=0\n";
    }
    if (c.startsWith("am start ")) return "Starting: Intent { \u2026 }\n";
    if (c.startsWith("pm disable-user ")) {
      const p = a[a.length - 1];
      if (this.o.box === "other" && p === "com.droidlogic.mboxlauncher") {
        return `Failure [not installed for 0]
java.lang.IllegalArgumentException: Cannot disable a protected package: ${p}
`;
      }
      this.disabled.push(p);
      return `Package ${p} new state: disabled
`;
    }
    if (c.startsWith("pm enable ")) return `Package ${a[2]} new state: enabled
`;
    if (c.startsWith("input keyevent")) return "";
    if (c.startsWith("input text ")) return "";
    if (c.startsWith("pm trim-caches")) return "";
    if (a[0] === "pm" && a[1] === "path" && a[2]) {
      if (!this.packages.has(a[2])) return "";
      return `package:/data/app/~~${a[2]}/base.apk
`;
    }
    if (c.startsWith("pm clear ")) return "Success\n";
    if (c === "wm size") return `Physical size: ${this.physicalSize}
` + (this.sizeOverride ? `Override size: ${this.sizeOverride}
` : "");
    if (c.startsWith("wm size ")) {
      this.sizeOverride = a[2] === "reset" ? null : a[2] ?? null;
      return "";
    }
    if (c === "wm density") return `Physical density: ${this.physicalDensity}
` + (this.densityOverride ? `Override density: ${this.densityOverride}
` : "");
    if (c.startsWith("wm density ")) {
      this.densityOverride = a[2] === "reset" ? null : Number(a[2]) || null;
      return "";
    }
    if (c === "date" || c.startsWith("date +")) return `${Math.floor(Date.now() / 1e3)}
`;
    if (c === "uptime") return " up 3 days, 4:21, 0 users, load average: 1.20 0.98 0.81\n";
    if (c.startsWith("screencap")) return "";
    if (c === "reboot") return "";
    if (c.startsWith("echo ")) return c.slice(5) + "\n";
    return `/system/bin/sh: ${a[0]}: inaccessible or not found
`;
  }
};
var MockDevice = class {
  constructor(info, box, wait) {
    this.info = info;
    this.box = box;
    this.wait = wait;
  }
  info;
  box;
  wait;
  serial = "7F3A9C12B04E";
  async authState() {
    return "authorized";
  }
  async shell(cmd) {
    await this.wait(120);
    return this.box.run(cmd);
  }
  async install(apk, opts = {}) {
    let bytes = 0;
    const reader = apk.getReader();
    for (; ; ) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
    await this.wait(900);
    if (opts.name) {
      const slug = opts.name.replace(/\.apk$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 18) || "app";
      const pkg2 = /\.apk$/i.test(opts.name) ? `com.sideload.${slug}` : opts.name;
      this.box.packages.set(pkg2, (this.box.packages.get(pkg2) ?? 0) + 1);
      if (pkg2.startsWith("com.sideload.") && !this.box.sideloaded.includes(pkg2)) this.box.sideloaded.push(pkg2);
    }
    return `Performing Streamed Install
Success (${bytes} bytes)
`;
  }
  /** XAPK στον mock: διαβάζει ΟΛΑ τα κομμάτια (άρα δοκιμάζεται αληθινά το ξεζίπωμα) και «βάζει» ένα πακέτο. */
  async installSplits(parts, opts = {}) {
    let bytes = 0;
    for (const part of parts) {
      const reader = (await part.open()).getReader();
      for (; ; ) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
      await this.wait(200);
    }
    if (opts.name) {
      const slug = opts.name.replace(/\.(xapk|apks|apkm)$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 18) || "app";
      const pkg2 = `com.sideload.${slug}`;
      this.box.packages.set(pkg2, (this.box.packages.get(pkg2) ?? 0) + 1);
      if (!this.box.sideloaded.includes(pkg2)) this.box.sideloaded.push(pkg2);
    }
    return `Performing Streamed Install
Success (${parts.length} parts, ${bytes} bytes)
`;
  }
  async pushFile(path, size, data) {
    const reader = data.getReader();
    for (; ; ) {
      const { done } = await reader.read();
      if (done) break;
    }
    await this.wait(300);
    void path;
    void size;
  }
  /** A file of plausible size, so the Backup page can be walked end to end with no box. */
  async pull(path) {
    await this.wait(400);
    const n = 1024 * 1024 * (path.includes("base.apk") ? 12 : 1);
    return new Uint8Array(n);
  }
  async screencap() {
    await this.wait(300);
    return new Uint8Array([137, 80, 78, 71]);
  }
  async reboot() {
    await this.wait(200);
  }
  /** Σαν αληθινό box: μία διεύθυνση ethernet, και η σύνδεση «πεθαίνει» γιατί το adbd ξαναξεκινά. */
  async openNetwork(port = 5555) {
    await this.wait(900);
    return { port, addresses: ["192.168.1.151"] };
  }
  async close() {
  }
};

// packages/adb/src/tcpip.ts
var PRIVATE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)\d/;
async function lanAddresses(shell) {
  const eth = [];
  const other = [];
  const add = (iface, ip) => {
    if (!PRIVATE.test(ip)) return;
    const list = /^(?:eth|usb)/.test(iface) ? eth : other;
    if (!eth.includes(ip) && !other.includes(ip)) list.push(ip);
  };
  try {
    for (const line of (await shell("ip -o -4 addr show")).split("\n")) {
      const m = /^\s*\d+:\s*(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)/.exec(line);
      if (m?.[1] && m[2]) add(m[1], m[2]);
    }
  } catch {
  }
  if (!eth.length && !other.length) {
    for (const iface of ["eth0", "wlan0", "eth1", "wlan1"]) {
      try {
        const ip = (await shell(`getprop dhcp.${iface}.ipaddress`)).trim();
        if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) add(iface, ip);
      } catch {
      }
    }
  }
  return [...eth, ...other];
}
async function openNetworkOn(adb, shell, port = 5555) {
  const addresses = await lanAddresses(shell);
  await adb.tcpip.setPort(port);
  return { port, addresses };
}

// packages/adb/src/index.ts
var UnauthorizedError = class extends Error {
  constructor(attempts) {
    super("unauthorized \u2014 press Allow on the TV");
    this.attempts = attempts;
    this.name = "UnauthorizedError";
  }
  attempts;
};
var NoDevicesError = class extends Error {
  constructor(hint) {
    super("no devices found");
    this.hint = hint;
    this.name = "NoDevicesError";
  }
  hint;
};

// brands/launcher.json
var launcher_default = {
  id: "launcher",
  name: "TV Launcher Manager",
  byline: "by TV Box Tools",
  launcherName: "Premium TV Launcher",
  launcherPackage: "com.premium.tv.launcher.ui",
  shortCode: "1166520",
  launcherHomeComponent: "com.premium.tv.launcher.ui/.LauncherActivity",
  launcherAccessibilityService: "com.premium.tv.launcher.ui/.HomeCaptureService",
  launcherNotificationListener: "com.premium.tv.launcher.ui/.data.PluiNotificationListenerService",
  launcherDeviceAdminReceiver: null,
  domain: "tvboxtools.com",
  siteLabel: "TVBoxTools.com",
  webPath: "/setup",
  manifestUrl: "https://tvboxtools.com/dl/manifest.json",
  agentPage: "https://tvboxtools.com/boxsetupai",
  privacyUrl: "https://tvboxtools.com/privacy/",
  termsUrl: "https://tvboxtools.com/terms/",
  cookiesUrl: "https://tvboxtools.com/cookies/",
  sourceUrl: "https://github.com/smartago/tvboxtools",
  androidAppId: "com.tv.launcher.manager.adb.tvboxtools",
  desktopProductName: "TVBoxTools",
  cli: "tvlm",
  flow: "disable-launcher",
  roleStep: false,
  accountCheck: false,
  profiles: [
    "open"
  ],
  homeMethods: [
    "disable-stock",
    "set-home-activity"
  ],
  accessibilityHome: false,
  launcherAsksAllPermissions: false,
  fireTv: "supported",
  never: [
    "factory-reset"
  ],
  tasks: [
    "launcher",
    "debloat",
    "apk",
    "backup",
    "free",
    "speedup",
    "display",
    "device",
    "remote",
    "screenshot",
    "console",
    "kiosk",
    "advanced"
  ],
  taskLinks: {},
  debugOffAtHandover: false,
  colors: {
    gradient: [
      "#0E1C3D",
      "#142A50",
      "#0F4438"
    ],
    cta: "#109F6F",
    ctaText: "#04140E",
    confirm: "#00A1A9",
    confirmSoft: "#7FD9D4",
    focus: "#FFCC00"
  },
  logo: {
    wordmark: "tvboxtools-logo-dark.png",
    icon: "tvboxtools-icon-512.png",
    _desktopIcon: "\u039C\u039F\u039D\u039F desktop (win/mac/linux). \u03A4\u03BF `icon` \u03C4\u03BF \u03B4\u03B9\u03B1\u03B2\u03AC\u03B6\u03B5\u03B9 \u039A\u0391\u0399 \u03C4\u03BF apps/android/scripts/icons.mjs \u2014 \u03B4\u03B5\u03BD \u03C4\u03BF \u03B1\u03B3\u03B3\u03AF\u03B6\u03BF\u03C5\u03BC\u03B5 (Jim, 2/10).",
    desktopIcon: "tvboxtools-icon-desktop-512.png",
    banner: "tvboxtools-banner.png",
    full: "tvboxtools-logo.png",
    onLight: false
  }
};

// brands/hotel.json
var hotel_default = {
  id: "hotel",
  name: "Hotel TV",
  byline: "the launcher the tool installs for hotels, BnBs and hospitals",
  launcherName: "HOTELTV",
  launcherPackage: "com.hotel.bnb.smart.hospitality.tv.launcher",
  shortCode: "2984172",
  launcherHomeComponent: "com.hotel.bnb.smart.hospitality.tv.launcher/com.premium.tv.launcher.ui.LauncherActivity",
  launcherAccessibilityService: "com.hotel.bnb.smart.hospitality.tv.launcher/com.premium.tv.launcher.ui.HomeCaptureService",
  launcherNotificationListener: "com.hotel.bnb.smart.hospitality.tv.launcher/com.premium.tv.launcher.ui.data.PluiNotificationListenerService",
  launcherDeviceAdminReceiver: "com.hotel.bnb.smart.hospitality.tv.launcher/com.premium.tv.launcher.ui.hotel.HotelDeviceAdminReceiver",
  domain: "hoteltvapp.com",
  siteLabel: "HotelTVApp.com",
  webPath: "/kiosk-manager",
  manifestUrl: "https://hoteltvapp.com/dl/manifest.json",
  agentPage: "https://hoteltvapp.com/boxsetupai",
  androidAppId: "com.tv.launcher.manager.adb.tvboxtools",
  desktopProductName: "TVBoxTools",
  cli: "tvlm",
  flow: "kiosk",
  roleStep: true,
  accountCheck: true,
  profiles: [
    "kiosk",
    "open",
    "install-only"
  ],
  homeMethods: [
    "set-home-activity",
    "device-owner",
    "disable-stock"
  ],
  accessibilityHome: true,
  launcherAsksAllPermissions: true,
  fireTv: "blocked",
  never: [],
  tasks: [],
  taskLinks: {},
  debugOffAtHandover: true,
  colors: {
    gradient: [
      "#0E1C3D",
      "#142A50",
      "#0F4438"
    ],
    cta: "#109F6F",
    ctaText: "#04140E",
    confirm: "#00A1A9",
    confirmSoft: "#7FD9D4",
    focus: "#FFCC00"
  },
  logo: {
    wordmark: "tvboxtools-logo-dark.png",
    icon: "tvboxtools-icon-512.png",
    _desktopIcon: "\u039C\u039F\u039D\u039F desktop (win/mac/linux). \u03A4\u03BF `icon` \u03C4\u03BF \u03B4\u03B9\u03B1\u03B2\u03AC\u03B6\u03B5\u03B9 \u039A\u0391\u0399 \u03C4\u03BF apps/android/scripts/icons.mjs \u2014 \u03B4\u03B5\u03BD \u03C4\u03BF \u03B1\u03B3\u03B3\u03AF\u03B6\u03BF\u03C5\u03BC\u03B5 (Jim, 2/10).",
    desktopIcon: "tvboxtools-icon-desktop-512.png",
    banner: "tvboxtools-banner.png",
    full: "tvboxtools-logo.png",
    onLight: false
  }
};

// packages/core/src/brand.ts
var BRANDS = {
  launcher: launcher_default
};
var TARGETS = {
  launcher: BRANDS.launcher,
  hotel: hotel_default
};
var TARGET_IDS = ["launcher", "hotel"];
function isTargetId(x) {
  return TARGET_IDS.includes(x);
}
function targetConfig(id) {
  const t = TARGETS[id];
  if (!t) throw new Error(`unknown target: ${id}`);
  return t;
}

// packages/core/src/gate.ts
var AUTO_PREFIXES = [
  "getprop",
  "dumpsys",
  "pm list",
  "pm path",
  "pm dump",
  "settings get",
  "settings list",
  "am start",
  "input keyevent",
  // typing on the television for someone who is looking at it: the remote's on-screen keyboard is
  // the thing being replaced, and what arrives is what the person typed. `input text` cannot reach
  // anything the remote could not.
  "input text",
  // the clock, for the diagnosis on the Device page. ONLY as a read: `date -s …` sets it, and the
  // rule below sends anything that is not a bare `date` or a `date +format` to confirm.
  "date",
  "cmd package resolve-activity",
  // reading which apps can be HOME is the same kind of question as resolving which one IS
  "cmd package query-activities",
  "cmd package list",
  "df",
  "screencap",
  "ls",
  "echo",
  "whoami",
  "id",
  "uptime",
  "cat /proc/meminfo",
  "wm size",
  "wm density",
  "ip addr",
  "ip route",
  "netstat"
];
var BLOCKED = [
  { re: /^reboot\s+(bootloader|recovery|fastboot|sideload)/, reason: "reboot into bootloader/recovery" },
  { re: /^fastboot\b/, reason: "fastboot" },
  { re: /^(rm\s+-rf?|dd\b)/, reason: "destructive filesystem command" },
  { re: /\bwipe\b/, reason: "wipe" },
  { re: /^su\b|\bsu\s+-c\b/, reason: "root" },
  { re: /^dpm\s+(remove-active-admin|clear-)/, reason: "device-owner removal happens only from the app or a factory reset" },
  // ΤΟ FACTORY RESET ΔΕΝ ΕΙΝΑΙ ΠΙΑ ΦΡΑΓΜΕΝΟ — ΕΙΝΑΙ `confirm` (Jim, 2/10/2026, για να μπορεί να
  // ξαναστήνει το δοκιμαστικό του κουτί από την αρχή). Μένει ΠΑΝΤΑ πίσω από ανθρώπινο «Τρέξε»:
  // κανένα βήμα, κανένα σενάριο, καμία αυτοματοποίηση δεν το φτάνει μόνο του — δες τον κανόνα
  // `confirm` πιο κάτω. Το `-p android` το θέλει το Android 8+ για να φτάσει στον receiver.
  { re: /^settings\s+put\s+global\s+adb_enabled\s+0/, reason: "turning debugging off is only the LAST step of handover" },
  { re: /^settings\s+put\s+global\s+development_settings_enabled\s+0/, reason: "turning developer options off cuts the session" }
];
var PROTECTED_PACKAGES = ["android", "com.android.settings", "com.android.systemui", "com.android.providers.settings", "com.google.android.gms", "com.android.vending"];
function normalizeCommand(cmd) {
  return cmd.trim().replace(/^adb\s+(-s\s+\S+\s+)?shell\s+/, "").replace(/\s+/g, " ");
}
var PLAY_FORBIDDEN = [
  { re: /^pm\s+uninstall\b/, reason: "uninstalling apps is not in the Google Play edition" },
  { re: /^pm\s+disable(-user)?\b/, reason: "disabling apps is not in the Google Play edition" },
  { re: /^cmd\s+package\s+(uninstall|disable(-user)?)\b/, reason: "disabling apps is not in the Google Play edition" }
];
function classifyCommand(cmd, opts = {}) {
  const c = normalizeCommand(cmd);
  if (!c) return { verdict: "blocked", reason: "empty command" };
  if (opts.playBuild) {
    for (const p of PLAY_FORBIDDEN) {
      if (p.re.test(c)) return { verdict: "blocked", reason: p.reason };
    }
  }
  for (const b of BLOCKED) {
    if (b.re.test(c)) {
      if (opts.handoverLastStep && /adb_enabled 0/.test(c)) break;
      return { verdict: "blocked", reason: b.reason };
    }
  }
  if (/^pm\s+(uninstall|disable(-user)?)\b/.test(c)) {
    const tokens = c.split(" ");
    for (const p of PROTECTED_PACKAGES) {
      if (tokens.includes(p)) return { verdict: "blocked", reason: `protected package ${p}` };
    }
    if (tokens.some((t) => /^com\.android\.(settings|systemui|providers\.)/.test(t))) return { verdict: "blocked", reason: "system package" };
  }
  if (/[;&|`$]/.test(c) && !/^echo\b/.test(c)) return { verdict: "confirm", reason: "compound command" };
  for (const p of AUTO_PREFIXES) {
    if (c === p || c.startsWith(p + " ")) {
      if (p === "am start" && /--e[sz]?\s|-d\s/.test(c)) return { verdict: "confirm", reason: "am start with extras" };
      if (p === "date" && !/^date(\s+\+\S*)?$/.test(c)) return { verdict: "confirm", reason: "date with arguments sets the clock" };
      if ((p === "wm size" || p === "wm density") && c !== p) return { verdict: "confirm", reason: "wm with an argument changes what the box draws" };
      return { verdict: "auto", reason: `allowlist: ${p}` };
    }
  }
  return { verdict: "confirm", reason: "not on the allowlist" };
}

// packages/core/src/launchers.ts
var KNOWN_LAUNCHERS = [
  { id: "projectivy", package: "com.spocky.projengmenu", name: "Projectivy Launcher", play: true },
  { id: "monet", package: "com.klevico.monet", name: "Monet Launcher", play: true },
  // ATV Launcher was here and Jim took it off the design on 21/9: five rows plus "other" fit the
  // screen without scrolling, and the list is "most popular", not "every launcher that exists".
  { id: "at4k", package: "com.overdevs.at4k", name: "AT4K Launcher", play: true }
];
var NOT_A_LAUNCHER = [/^com\.android\.tv\.settings\b/, /^com\.android\.settings\b/, /FallbackHome$/, /^android$/, /ResolverActivity$/];
function stockLauncherOf(currentHome, fallback, ourLauncher, installed) {
  const active = currentHome?.split("/")[0]?.trim() || null;
  if (active && active !== ourLauncher && !KNOWN_LAUNCHERS.some((k) => k.package === active) && !NOT_A_LAUNCHER.some((rx) => rx.test(active))) {
    return active;
  }
  if (fallback && installed) {
    const pk = installed instanceof Set ? installed : new Set(installed);
    return pk.has(fallback) ? fallback : null;
  }
  return fallback;
}

// packages/core/src/check.ts
var CHECK_COMMANDS = {
  getprop: "getprop",
  accounts: "dumpsys account",
  df: "df /data",
  // ΔΥΟ ΕΝΤΟΛΕΣ ΓΙΑ ΤΗΝ ΙΔΙΑ ΛΙΣΤΑ, ΚΑΙ ΧΡΕΙΑΖΟΝΤΑΙ ΚΑΙ ΟΙ ΔΥΟ (κουτί Jim, 2/10/2026):
  // το `--show-versioncode` μπήκε στο Android 9 (API 28). Σε Android 7/8 το `pm` **δεν απαντά
  // τίποτα** και βγαίνει με σφάλμα — οπότε η λίστα πακέτων ερχόταν ΑΔΕΙΑ και ΟΛΑ έδειχναν «δεν
  // υπάρχει»: ο launcher που μόλις είχαμε εγκαταστήσει, οι εφαρμογές στο Debloat, το backup.
  // Το `pm list packages` σκέτο δουλεύει από πάντα· οι εκδόσεις μπαίνουν από πάνω όπου υπάρχουν.
  packagesPlain: "pm list packages",
  packages: "pm list packages --show-versioncode",
  devSettings: "settings get global development_settings_enabled",
  adbEnabled: "settings get global adb_enabled",
  home: "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME",
  // Everything that CAN be home, not just what is. The picker is built from this: the box writes
  // the list, we never maintain one (docs/LAUNCHER_PICKER_PLAN.md).
  homeApps: "cmd package query-activities --components -a android.intent.action.MAIN -c android.intent.category.HOME",
  // ΠΟΙΟΣ ΕΙΝΑΙ ΦΤΙΑΓΜΕΝΟΣ ΓΙΑ ΤΗΛΕΟΡΑΣΗ (Jim, 3/10/2026): ο `com.android.launcher` του AOSP
  // ΜΠΟΡΕΙ να ανοίξει στο HOME, αλλά είναι launcher ΚΙΝΗΤΟΥ — στην τηλεόραση λέει «touch the
  // circle» σε συσκευή χωρίς οθόνη αφής. Το ποιος δηλώνει LEANBACK το ξέρει το ίδιο το box.
  tvApps: "cmd package query-activities --components -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER",
  deviceOwner: "dumpsys device_policy"
};
function parseGetprop(out) {
  const props = {};
  for (const line of out.split("\n")) {
    const m = /^\[([^\]]+)\]:\s*\[(.*)\]\s*$/.exec(line.trim());
    if (m) props[m[1]] = m[2];
  }
  return props;
}
function parseAccounts(out) {
  const names = /* @__PURE__ */ new Set();
  for (const line of out.split("\n")) {
    const m = /Account\s*\{name=([^,}]+),\s*type=([^}]+)\}/.exec(line);
    if (m) names.add(m[1].trim());
  }
  return [...names];
}
function parseDf(out) {
  const lines = out.trim().split("\n");
  const data = lines.find((l, i) => i > 0 && /\/data\b|\/data$/.test(l)) ?? lines[1];
  if (!data) return { free: null, total: null };
  const cols = data.trim().split(/\s+/);
  const total = toBytes(cols[1]);
  const free = toBytes(cols[3]);
  return { free, total };
}
function toBytes(v) {
  if (!v) return null;
  const m = /^(\d+(?:\.\d+)?)([KMGT]?)$/i.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? "").toUpperCase();
  const mult = unit === "" ? 1024 : unit === "K" ? 1024 : unit === "M" ? 1024 ** 2 : unit === "G" ? 1024 ** 3 : 1024 ** 4;
  return Math.round(n * mult);
}
function parsePackages(out) {
  const map = /* @__PURE__ */ new Map();
  for (const line of out.split("\n")) {
    const m = /^package:(\S+?)(?:\s+versionCode:(\d+))?\s*$/.exec(line.trim());
    if (m) map.set(m[1], m[2] ? parseInt(m[2], 10) : null);
  }
  return map;
}
function parseResolvedHome(out) {
  const line = out.trim().split("\n").map((l) => l.trim()).find((l) => /^[\w.]+\/[\w.$]+$/.test(l));
  return line ?? null;
}
function parseDeviceOwner(out) {
  const m = /Device Owner:\s*\n?\s*admin=ComponentInfo\{([^}]+)\}/.exec(out) ?? /Device Owner:[^\n]*\n\s*(?:admin=)?ComponentInfo\{([^}]+)\}/.exec(out);
  if (m) return m[1];
  const m2 = /Device Owner:\s*\n?\s*(?:package|admin)=([\w.]+)/.exec(out);
  return m2 ? m2[1] : null;
}
function parseHomeApps(out) {
  const found = [];
  const add = (pkg2, cls2) => {
    const component = cls2.startsWith(".") || !cls2.includes(".") ? `${pkg2}/${cls2.startsWith(".") ? cls2 : "." + cls2}` : `${pkg2}/${cls2}`;
    if (!found.some((f) => f.package === pkg2)) found.push({ package: pkg2, component });
  };
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    const m = /^([a-zA-Z][\w.]*[\w])\/([\w.$]+)$/.exec(line);
    if (m) add(m[1], m[2]);
  }
  if (found.length) return found;
  let cls = null;
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    const n = /^name=([\w.$]+)$/.exec(line);
    if (n) {
      cls = n[1];
      continue;
    }
    const p = /^packageName=([\w.]+)$/.exec(line);
    if (p && cls) {
      add(p[1], cls.startsWith(p[1] + ".") ? cls.slice(p[1].length) : cls);
      cls = null;
    }
  }
  return found;
}
var STOCK_LAUNCHERS = {
  googletv: "com.google.android.apps.tv.launcherx",
  androidtv: "com.google.android.tvlauncher",
  firetv: "com.amazon.tv.launcher"
};
function detectPlatform(props, packages) {
  const pk = new Set(packages);
  if (props["ro.product.manufacturer"]?.toLowerCase() === "amazon" || pk.has("com.amazon.tv.launcher")) return "firetv";
  if (pk.has("com.google.android.apps.tv.launcherx")) return "googletv";
  if (pk.has("com.google.android.tvlauncher")) return "androidtv";
  return "other";
}
function buildCheck(outputs, launcherPackage) {
  const props = parseGetprop(outputs.getprop ?? "");
  const packages = parsePackages(outputs.packagesPlain ?? "");
  for (const [pkg2, code] of parsePackages(outputs.packages ?? "")) {
    if (code !== null || !packages.has(pkg2)) packages.set(pkg2, code);
  }
  const platform = detectPlatform(props, packages.keys());
  const df = parseDf(outputs.df ?? "");
  const features = props["ro.build.characteristics"] ?? "";
  return {
    model: props["ro.product.model"] ?? "",
    manufacturer: props["ro.product.manufacturer"] ?? "",
    brand: props["ro.product.brand"] ?? "",
    device: props["ro.product.device"] ?? "",
    serial: props["ro.serialno"] ?? props["ro.boot.serialno"] ?? "",
    androidVersion: props["ro.build.version.release"] ?? "",
    sdk: parseInt(props["ro.build.version.sdk"] ?? "0", 10) || 0,
    platform,
    isTv: /tv/.test(features) || platform !== "other",
    accounts: parseAccounts(outputs.accounts ?? ""),
    freeBytes: df.free,
    totalBytes: df.total,
    hasPlay: packages.has("com.android.vending"),
    launcherInstalled: packages.has(launcherPackage),
    launcherVersionCode: packages.get(launcherPackage) ?? null,
    installedPackages: [...packages.keys()],
    developerOptions: (outputs.devSettings ?? "").trim() === "1",
    adbEnabled: (outputs.adbEnabled ?? "").trim() === "1",
    // Ο ΕΝΕΡΓΟΣ launcher πρώτα, ο πίνακας μόνο ως εφεδρεία — δες stockLauncherOf() για το γιατί.
    stockLauncher: stockLauncherOf(parseResolvedHome(outputs.home ?? ""), STOCK_LAUNCHERS[platform] ?? null, launcherPackage, packages.keys()),
    currentHome: parseResolvedHome(outputs.home ?? ""),
    homeApps: parseHomeApps(outputs.homeApps ?? ""),
    tvApps: parseHomeApps(outputs.tvApps ?? "").map((a) => a.package),
    deviceOwner: parseDeviceOwner(outputs.deviceOwner ?? "")
  };
}

// packages/core/src/manifest.ts
var OUR_HOSTS = ["smartago.net", "tvboxtools.com", "hoteltvapp.com", "pluitv.com", "zukka.app"];
function ourFile(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && OUR_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}
function validateManifest(x) {
  if (!x || typeof x !== "object") throw new Error("manifest: not an object");
  const m = x;
  if (m.schema !== 1) throw new Error(`manifest: unsupported schema ${String(m.schema)}`);
  if (!m.tool || typeof m.tool.version !== "string") throw new Error("manifest: tool.version missing");
  if (!Array.isArray(m.apps)) throw new Error("manifest: apps missing");
  for (const a of m.apps) {
    for (const k of ["pkg", "name", "url", "sha256"]) {
      if (typeof a[k] !== "string" || !a[k]) throw new Error(`manifest: app ${a.pkg ?? "?"} missing ${k}`);
    }
    if (!/^[0-9a-f]{64}$/i.test(a.sha256)) throw new Error(`manifest: app ${a.pkg} sha256 malformed`);
    if (typeof a.versionCode !== "number") throw new Error(`manifest: app ${a.pkg} versionCode missing`);
    if (typeof a.required !== "boolean") throw new Error(`manifest: app ${a.pkg} required missing`);
    if (!Array.isArray(a.role)) throw new Error(`manifest: app ${a.pkg} role missing`);
  }
  return m;
}
function pickApps(m, opts) {
  const out = [];
  const groupsDone = /* @__PURE__ */ new Set();
  if (opts.only) return m.apps.filter((a) => opts.only.includes(a.pkg)).map((a) => withAction(a, opts.installed));
  const byGroup = /* @__PURE__ */ new Map();
  for (const a of m.apps) if (a.group) byGroup.set(a.group, [...byGroup.get(a.group) ?? [], a]);
  for (const a of m.apps) {
    if (a.group) {
      if (groupsDone.has(a.group)) continue;
      const chosen = opts.choices?.[a.group];
      const members = byGroup.get(a.group);
      const pick = chosen ? members.find((x) => x.pkg === chosen) : members.find((x) => x.required && x.role.includes(opts.role));
      groupsDone.add(a.group);
      if (!pick) continue;
      out.push(withAction(pick, opts.installed));
      continue;
    }
    if (!a.required || !a.role.includes(opts.role)) continue;
    out.push(withAction(a, opts.installed));
  }
  return out;
}
function withAction(a, installed) {
  const have = installed?.get(a.pkg);
  if (have === void 0) return { ...a, action: "install" };
  if (have !== null && have >= a.versionCode) return { ...a, action: "skip-current" };
  return { ...a, action: "update" };
}

// packages/core/src/steps.ts
var pkg = (c) => c.brand.launcherPackage;
function renderCommand(step, ctx) {
  const map = {
    pkg: pkg(ctx),
    home: ctx.homeTarget || ctx.brand.launcherHomeComponent,
    acs: ctx.brand.launcherAccessibilityService,
    notif: ctx.brand.launcherNotificationListener,
    dpc: ctx.brand.launcherDeviceAdminReceiver ?? "",
    stock: ctx.stockLauncher ?? "",
    lang: ctx.lang,
    profile: ctx.profile,
    code: ctx.linkCode ?? "",
    extras: ctx.provisionExtras ?? "",
    pin: ctx.pin ?? "",
    minutes: String(ctx.minutes ?? 15)
  };
  return step.cmd.replace(/\{(\w+)\}/g, (_, k) => map[k] ?? `{${k}}`);
}
function expandComponent(s) {
  const i = s.indexOf("/");
  if (i < 0) return s;
  const pkg2 = s.slice(0, i);
  const cls = s.slice(i + 1);
  return cls.startsWith(".") ? `${pkg2}/${pkg2}${cls}` : `${pkg2}/${cls}`;
}
function stepSucceeded(step, output, expectRendered) {
  if (step.fail && new RegExp(step.fail, "i").test(output)) return false;
  if (expectRendered) {
    const hay = output.toLowerCase();
    const want = expectRendered.toLowerCase();
    if (hay.includes(want)) return true;
    const wantLong = expandComponent(expectRendered).toLowerCase();
    if (hay.includes(wantLong)) return true;
    return (output.match(/[\w.]+\/[.\w$]+/g) ?? []).some((c) => expandComponent(c).toLowerCase() === wantLong);
  }
  if (step.expect) return new RegExp(step.expect, "i").test(output);
  return !/(^|\n)\s*(Error|Failure|Exception|SecurityException|java\.lang\.)/i.test(output);
}
function stockIsNotTheTarget(c) {
  if (!c.stockLauncher) return false;
  const target = (c.homeTarget || c.brand.launcherHomeComponent).split("/")[0];
  return c.stockLauncher !== target;
}
var STEPS = [
  // ---- profile (the hotel road: the target has a device-admin receiver; PLUI has none)
  {
    id: "kiosk.deviceOwner",
    task: "profile",
    label: "st_deviceOwner",
    cmd: "dpm set-device-owner {dpc}",
    expect: "Success|Active admin set|already set",
    fail: "already several users|already some accounts|not allowed",
    onFail: "err_deviceOwner",
    when: (c) => c.profile === "kiosk" && !!c.brand.launcherDeviceAdminReceiver
  },
  {
    id: "profile.broadcast",
    task: "profile",
    label: "st_profile",
    // `keepAdb`: the hotel app's kiosk profile adds DISALLOW_DEBUGGING_FEATURES unless told not to
    // (hotel ProvisionReceiver, b6aab2d) — without it this broadcast cut adb in the middle of the
    // automatic run and every step after it failed. Cutting adb is the host's call, not this run's.
    // No `--es lang`: the tool's language is the RESELLER's. The box's language is the host's, and
    // the app suggests it from the IP the host connects from, on its own Language step (Jim, 24/9).
    cmd: "am broadcast -a {pkg}.PROVISION -p {pkg} --es profile {profile} --ez skipWizard true --ez keepAdb true{extras}",
    expect: "Broadcast completed",
    onFail: "err_profile"
  },
  {
    id: "profile.link",
    task: "profile",
    label: "st_link",
    cmd: "am broadcast -a {pkg}.LINK -p {pkg} --es code {code}",
    expect: "Broadcast completed",
    onFail: "err_link",
    when: (c) => !!c.linkCode
  },
  // ---- launcher (order per brand.homeMethods; the engine filters by method)
  {
    id: "home.setHomeActivity",
    task: "launcher",
    label: "st_setHome",
    cmd: "cmd package set-home-activity {home}",
    fail: "Error|Exception|Unknown command",
    onFail: "err_setHome"
  },
  {
    id: "home.verify",
    task: "launcher",
    label: "st_verifyHome",
    cmd: "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME",
    // the box's answer must BE the home we asked for — `homeAsk` has no single answer to expect
    expectRendered: "{home}",
    onFail: "err_verifyHome",
    when: (c) => !c.homeAsk
  },
  {
    id: "home.persistent",
    task: "launcher",
    label: "st_persistentHome",
    cmd: "am broadcast -a {pkg}.PROVISION -p {pkg} --es profile kiosk --es home persistent --ez keepAdb true",
    expect: "Broadcast completed",
    onFail: "err_persistentHome",
    // Only our own app understands this broadcast, so a foreign home target skips it.
    when: (c) => c.profile === "kiosk" && !c.homeTarget
  },
  {
    // HOTELTV fallback (§4.3): the stock launcher goes off, the TV asks "Select a Home app" on the next HOME.
    id: "home.disableStock",
    task: "launcher",
    label: "st_disableStock",
    cmd: "pm disable-user --user 0 {stock}",
    expect: "new state: disabled",
    onFail: "err_disableStock",
    when: (c) => !!c.stockLauncher,
    humanAfter: "pickLauncher"
  },
  {
    // PLUI default (§14): same command, but followed by set-home-activity so the TV never asks.
    id: "home.disableStockSilent",
    task: "launcher",
    label: "st_disableStock",
    cmd: "pm disable-user --user 0 {stock}",
    expect: "new state: disabled",
    onFail: "err_disableStock",
    when: stockIsNotTheTarget
  },
  // ---- configure (silent grants)
  { id: "cfg.overlay", task: "configure", label: "st_overlay", cmd: "appops set {pkg} SYSTEM_ALERT_WINDOW allow", onFail: "err_grant" },
  // The box asked for this one by hand on the first real install (23/9): a launcher that can update
  // itself needs it, and appops grants it without a single screen on the television.
  { id: "cfg.installUnknown", task: "configure", label: "st_installUnknown", cmd: "appops set {pkg} REQUEST_INSTALL_PACKAGES allow", onFail: "err_grant" },
  { id: "cfg.usage", task: "configure", label: "st_usage", cmd: "appops set {pkg} GET_USAGE_STATS allow", onFail: "err_grant" },
  { id: "cfg.notif", task: "configure", label: "st_notif", cmd: "cmd notification allow_listener {notif}", onFail: "err_grant" },
  { id: "cfg.tvl", task: "configure", label: "st_tvl", cmd: "pm grant {pkg} android.permission.READ_TV_LISTINGS", onFail: "err_grant" },
  // The hotel launcher's wizard walks EVERY permission (docs/hoteltv.md: the guest must never see
  // a popup), so the tool grants every one of them here and that wizard has nothing left to ask
  // (Jim, 24/9). Battery: the "keep running in background" dialog. Photos: the runtime permission
  // whose name changed at API 33 — the box's own level decides which one exists to grant.
  { id: "cfg.battery", task: "configure", label: "st_battery", cmd: "dumpsys deviceidle whitelist +{pkg}", onFail: "err_grant", when: (c) => c.brand.launcherAsksAllPermissions && c.keepBackground !== false },
  // Install screen, "only now, via ADB": what the app cannot give itself later.
  { id: "cfg.secure", task: "configure", label: "st_secure", cmd: "pm grant {pkg} android.permission.WRITE_SECURE_SETTINGS", onFail: "err_grant", when: (c) => !!c.grantSecureSettings },
  {
    id: "cfg.hideStock",
    task: "configure",
    label: "st_hideStock",
    cmd: "pm disable-user --user 0 {stock}",
    expect: "new state: disabled",
    onFail: "err_disableStock",
    // only after HOME is ours: a box with the stock launcher off and nothing pinned has no home.
    // On the kiosk road the launcher task already switched it off — no need to say it twice.
    when: (c) => !!c.hideStock && !!c.stockLauncher && !c.homeTarget && c.profile !== "kiosk"
  },
  { id: "cfg.photos", task: "configure", label: "st_photos", cmd: "pm grant {pkg} android.permission.READ_MEDIA_IMAGES", onFail: "err_grant", when: (c) => c.brand.launcherAsksAllPermissions && (c.sdk ?? 33) >= 33 },
  { id: "cfg.photosLegacy", task: "configure", label: "st_photos", cmd: "pm grant {pkg} android.permission.READ_EXTERNAL_STORAGE", onFail: "err_grant", when: (c) => c.brand.launcherAsksAllPermissions && (c.sdk ?? 33) < 33 },
  {
    id: "cfg.acs",
    task: "configure",
    label: "st_acs",
    cmd: "settings put secure enabled_accessibility_services {acs}",
    onFail: "err_grant",
    when: (c) => c.profile === "open" && c.brand.accessibilityHome
  },
  {
    id: "cfg.acsOn",
    task: "configure",
    label: "st_acsOn",
    cmd: "settings put secure accessibility_enabled 1",
    onFail: "err_grant",
    when: (c) => c.profile === "open" && c.brand.accessibilityHome
  },
  // ---- test
  { id: "test.home", task: "test", label: "st_testHome", cmd: "input keyevent KEYCODE_HOME", onFail: "err_test" },
  { id: "test.resolve", task: "test", label: "st_testResolve", cmd: "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME", onFail: "err_test" },
  { id: "test.shot", task: "test", label: "st_testShot", cmd: "screencap -p /sdcard/tvlm-test.png", onFail: "err_test" },
  { id: "test.reboot", task: "test", label: "st_testReboot", cmd: "reboot", onFail: "err_test", humanAfter: "reboot", expectsDisconnect: true, when: (c) => !c.selfBox },
  // ---- handover
  {
    id: "handover.debugOff",
    task: "handover",
    label: "st_debugOff",
    cmd: "settings put global adb_enabled 0",
    onFail: "err_debugOff",
    when: (c) => !!c.debugOff,
    handoverLastStep: true
  },
  // ---- maintenance
  {
    id: "maint.pause",
    task: "maintenance",
    label: "st_maint",
    cmd: "am broadcast -a {pkg}.MAINTENANCE -p {pkg} --es pin {pin} --ei minutes {minutes}",
    expect: "Broadcast completed",
    onFail: "err_maint",
    when: (c) => !!c.pin
  }
];
function homeSteps(method, ctx) {
  const brand = ctx.brand;
  switch (method) {
    case "set-home-activity":
      return ctx.profile === "kiosk" ? ["home.disableStockSilent", "home.setHomeActivity", "home.verify"] : ["home.setHomeActivity", "home.verify"];
    case "device-owner":
      return ["home.persistent"];
    case "disable-stock":
      return !ctx.homeAsk && brand.flow === "disable-launcher" && brand.homeMethods.includes("set-home-activity") ? ["home.disableStockSilent", "home.setHomeActivity", "home.verify"] : ["home.disableStock"];
  }
}
function stepsFor(q, ctx) {
  let list = STEPS.filter((s) => s.task === q.task);
  if (q.task === "launcher") {
    const method = q.homeMethod ?? ctx.brand.homeMethods[0];
    if (!method || !ctx.brand.homeMethods.includes(method)) return [];
    const ids = homeSteps(method, ctx);
    list = ids.map((id) => STEPS.find((s) => s.id === id)).filter(Boolean);
  }
  if (q.task === "profile" && ctx.profile === "kiosk" && !ctx.brand.launcherDeviceAdminReceiver) return [];
  return list.filter((s) => !s.when || s.when(ctx));
}
function autoRunOrder(_brand) {
  return ["install", "profile", "launcher", "configure", "test", "handover"];
}

// packages/core/src/report.ts
var SessionReport = class {
  constructor(meta) {
    this.meta = meta;
  }
  meta;
  entries = [];
  seq = 0;
  add(kind, text, extra = {}) {
    const e = { id: ++this.seq, t: Date.now(), kind, text, ...extra };
    this.entries.push(e);
    return e;
  }
  toText() {
    const lines = [
      `${this.meta.tool} ${this.meta.version} \u2014 brand ${this.meta.brand}`,
      `started ${new Date(this.meta.startedAt).toISOString()}`,
      this.meta.device ? `device ${this.meta.device.model} (${this.meta.device.serial}) ${this.meta.device.addr}` : "device \u2014",
      ""
    ];
    for (const e of this.entries) {
      const ts = new Date(e.t).toISOString().slice(11, 19);
      const tag = e.kind === "cmd" ? `$ ` : e.kind === "out" ? "  " : `[${e.kind}] `;
      lines.push(`${ts} ${tag}${e.text}${e.verdict ? `   (${e.verdict})` : ""}`);
    }
    return lines.join("\n");
  }
  toJSON() {
    return { meta: this.meta, entries: this.entries };
  }
};

// packages/core/src/engine.ts
async function sentAndGone(p, ms = 8e3) {
  let timer;
  try {
    return await Promise.race([
      p.catch(() => ""),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(""), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
var ProvisionEngine = class {
  o;
  constructor(o) {
    this.o = o;
  }
  emit(e) {
    this.o.onEvent?.(e);
  }
  /** Run one raw command through the gate (UI console, MCP `shell`). */
  async exec(cmd, opts = {}) {
    const g = classifyCommand(cmd, { handoverLastStep: opts.handoverLastStep, playBuild: this.o.playBuild });
    this.o.report.add("cmd", cmd, { verdict: g.verdict, stepId: opts.stepId });
    if (g.verdict === "blocked") {
      this.o.report.add("err", `blocked: ${g.reason}`);
      return { verdict: g.verdict, output: "", ran: false };
    }
    if (g.verdict === "confirm") {
      const ok2 = this.o.confirm ? await this.o.confirm(cmd, { id: opts.stepId ?? "raw", task: "maintenance", label: "raw", cmd, onFail: "err_raw" }) : false;
      if (!ok2) {
        this.o.report.add("warn", "skipped (not confirmed)");
        return { verdict: g.verdict, output: "", ran: false };
      }
    }
    const output = opts.expectsDisconnect ? await sentAndGone(this.o.shell.shell(cmd)) : await this.o.shell.shell(cmd);
    if (output.trim()) this.o.report.add("out", output.trimEnd());
    return { verdict: g.verdict, output, ran: true };
  }
  /** Wizard step 8 / `tvlm --check`. Read-only. */
  async check() {
    const outputs = {};
    for (const [key, cmd] of Object.entries(CHECK_COMMANDS)) {
      const r = await this.exec(cmd);
      outputs[key] = r.output;
    }
    return buildCheck(outputs, this.o.brand.launcherPackage);
  }
  /** One task (profile / launcher / configure / test / handover / maintenance) — the shell-step kind. */
  async runTask(task, ctx, homeMethod) {
    this.emit({ type: "task:start", task });
    let allOk = true;
    for (const step of stepsFor({ task, homeMethod }, ctx)) {
      const cmd = renderCommand(step, ctx);
      const g = classifyCommand(cmd, { handoverLastStep: step.handoverLastStep, playBuild: this.o.playBuild });
      this.emit({ type: "step:start", step, cmd, verdict: g.verdict });
      if (g.verdict === "confirm") this.emit({ type: "step:confirm", step, cmd });
      const r = await this.exec(cmd, { stepId: step.id, handoverLastStep: step.handoverLastStep, expectsDisconnect: step.expectsDisconnect });
      const ok2 = r.ran && stepSucceeded(step, r.output, step.expectRendered ? renderCommand({ ...step, cmd: step.expectRendered }, ctx) : void 0);
      this.emit({ type: "step:done", step, ok: ok2, output: r.output });
      if (!ok2) {
        this.o.report.add("err", step.onFail);
        this.o.onStepFailed?.(step, r.output);
        if (task === "configure") {
          allOk = false;
          continue;
        }
        if (await this.o.onFailure?.(step, cmd, r.output)) {
          this.emit({ type: "log", kind: "warn", text: `${step.id}: failed, carried on by the operator` });
          continue;
        }
        allOk = false;
        break;
      }
      if (step.humanAfter) {
        this.emit({ type: "step:human", step, what: step.humanAfter });
        await this.o.human?.(step.humanAfter, step);
      }
    }
    this.emit({ type: "task:done", task, ok: allOk });
    return allOk;
  }
  /** Install from the manifest: stream → sha256 → `install`. Never touches the phone's storage. */
  async install(manifest, role, opts = {}) {
    this.emit({ type: "task:start", task: "install" });
    const { fetchApk: fetchApk2, sha256 } = this.o;
    if (!fetchApk2 || !sha256) {
      this.emit({ type: "log", kind: "err", text: "install: host gave no fetchApk/sha256" });
      this.emit({ type: "task:done", task: "install", ok: false });
      return false;
    }
    let allOk = true;
    for (const app of pickApps(manifest, { role, choices: opts.choices, installed: opts.installed, only: opts.only })) {
      if (app.action === "skip-current") {
        this.emit({ type: "install:app", app, phase: "skip", detail: "up to date" });
        this.o.report.add("info", `${app.pkg} up to date (${app.versionCode})`);
        continue;
      }
      try {
        this.emit({ type: "install:app", app, phase: "download" });
        const { stream, size } = await fetchApk2(app.url);
        const [forHash, forInstall] = stream.tee();
        this.emit({ type: "install:app", app, phase: "verify" });
        const hex = await sha256(forHash);
        if (hex.toLowerCase() !== app.sha256.toLowerCase()) {
          if (ourFile(app.url)) {
            this.emit({ type: "log", kind: "warn", text: `${app.pkg}: newer build than the manifest knows (sha256 differs) \u2014 installing it anyway, it is ours over HTTPS` });
            this.o.report.add("warn", `${app.pkg}: manifest sha256 is out of date (${app.sha256.slice(0, 12)}\u2026 vs ${hex.slice(0, 12)}\u2026)`);
          } else {
            await forInstall.cancel();
            throw new Error(`sha256 mismatch for ${app.pkg}`);
          }
        }
        this.emit({ type: "install:app", app, phase: "install" });
        this.o.report.add("cmd", `install -r ${app.name} (${app.pkg} ${app.versionCode})`, { verdict: "confirm", stepId: `install.${app.pkg}` });
        const out = await this.o.shell.install(forInstall, { size, name: app.pkg });
        this.o.report.add("out", out.trimEnd());
        if (!/Success/i.test(out)) throw new Error(out.trim() || "install failed");
        this.emit({ type: "install:app", app, phase: "done" });
      } catch (e) {
        allOk = false;
        const msg = e instanceof Error ? e.message : String(e);
        this.o.report.add("err", msg);
        this.emit({ type: "log", kind: "err", text: msg });
      }
    }
    this.emit({ type: "task:done", task: "install", ok: allOk });
    return allOk;
  }
  /**
   * An APK the person picked off their own disk — the "Install my APK" tile (TASKS_HUB_PLAN §4),
   * and the one thing every sideloader opens a tool for. No manifest, no digest to compare against:
   * the file is theirs, they chose it, and the report says what was sent. It is written down the
   * same way an install from the manifest is, so a box's report is still the whole story.
   */
  async installFile(apk, opts = {}) {
    this.emit({ type: "task:start", task: "install" });
    this.o.report.add("cmd", `install -r ${opts.name ?? "local file"}${opts.size ? ` (${opts.size} bytes)` : ""}`, { verdict: "confirm", stepId: "install.local" });
    try {
      const out = await this.o.shell.install(apk, opts);
      const ok2 = /Success/i.test(out);
      this.o.report.add(ok2 ? "out" : "err", out.trim() || "install failed");
      this.emit({ type: "task:done", task: "install", ok: ok2 });
      return out;
    } catch (e) {
      this.emit({ type: "task:done", task: "install", ok: false });
      throw e;
    }
  }
  /**
   * ΕΝΑ XAPK: base + κομμάτια ΜΑΖΙ, σε μία συνεδρία του `pm`, και μετά τα OBB αν υπάρχουν.
   * Ό,τι ισχύει για το `installFile` ισχύει και εδώ: δύο μηνύματα ώστε ο διάλογος να ανοίγει και
   * να κλείνει, και η κονσόλα να γράφει τι στάλθηκε.
   */
  async installBundle(parts, obb = [], opts = {}) {
    if (!this.o.shell.installSplits) throw new Error("err_noSplits");
    this.emit({ type: "task:start", task: "install" });
    const total = parts.reduce((n, p) => n + p.size, 0);
    this.o.report.add("cmd", `install-multiple ${opts.name ?? "bundle"} (${parts.length} parts, ${total} bytes)`, { verdict: "confirm", stepId: "install.bundle" });
    try {
      const out = await this.o.shell.installSplits(parts, { name: opts.name });
      const ok2 = /Success/i.test(out);
      this.o.report.add(ok2 ? "out" : "err", out.trim() || "install failed");
      if (ok2 && obb.length) {
        if (!this.o.shell.pushFile) {
          this.o.report.add("warn", `${obb.length} obb file(s) not sent: this connection cannot push files`);
        } else {
          for (const f of obb) {
            this.o.report.add("cmd", `push ${f.target} (${f.size} bytes)`, { verdict: "confirm", stepId: "install.obb" });
            await this.o.shell.pushFile(f.target, f.size, await f.open());
          }
        }
      }
      this.emit({ type: "task:done", task: "install", ok: ok2 });
      return out;
    } catch (e) {
      this.emit({ type: "task:done", task: "install", ok: false });
      throw e;
    }
  }
  /** Μπορεί ΑΥΤΗ η σύνδεση να βάλει πολλαπλά apk; (η γέφυρα δεν μπορεί — δες AdbShell) */
  get canInstallSplits() {
    return !!this.o.shell.installSplits;
  }
  /** The "Automatic" run (DESIGN_NOTES §2): everything in the brand's order, stopping only for hands. */
  async autoRun(ctx, manifest, role, order = autoRunOrder(this.o.brand)) {
    const result = { profile: null, install: null, launcher: null, configure: null, test: null, handover: null, maintenance: null };
    for (const task of order) {
      if (task === "install") {
        result.install = manifest ? await this.install(manifest, role) : false;
        if (!result.install) break;
        continue;
      }
      result[task] = await this.runTask(task, ctx);
      if (!result[task] && task !== "configure" && task !== "test") break;
    }
    return result;
  }
};

// packages/core/src/index.ts
var TOOL_VERSION = "1.26.10.07";

// apps/cli/src/bridge.ts
import { WebSocketServer } from "ws";

// packages/adb/src/bridge.ts
var BRIDGE_PORT = 15555;
var BRIDGE_URL = `ws://127.0.0.1:${BRIDGE_PORT}`;
var BRIDGE_PROTOCOL_VERSION = 1;
function decodeBinaryFrame(frame) {
  if (frame.byteLength < 4) throw new Error("bridge: short binary frame");
  const id = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true);
  return { id, chunk: frame.subarray(4) };
}
var BridgeErrorCode = { unauthorized: 4001, noDevices: 4002, notFound: 4004, internal: 5e3 };

// apps/cli/src/bridge.ts
var DEFAULT_ORIGINS = ["localhost", "127.0.0.1", "hoteltvapp.com", "www.hoteltvapp.com", "pluitv.com", "www.pluitv.com"];
function originAllowed(origin, extra = []) {
  if (!origin || origin === "null" || origin.startsWith("file://") || origin.startsWith("tvlm://")) return true;
  try {
    const host = new URL(origin).hostname;
    return [...DEFAULT_ORIGINS, ...extra].includes(host);
  } catch {
    return false;
  }
}
async function runBridge(o) {
  const port = o.port ?? BRIDGE_PORT;
  const host = o.host ?? "127.0.0.1";
  const log = o.log ?? (() => {
  });
  const wss = new WebSocketServer({ host, port });
  await new Promise((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", reject);
  });
  wss.on("connection", (ws, req) => {
    if (!originAllowed(req.headers.origin, o.origins)) {
      log(`refused origin ${req.headers.origin}`);
      ws.close(1008, "origin not allowed");
      return;
    }
    log(`client connected (${req.headers.origin ?? "no origin"})`);
    const devices = /* @__PURE__ */ new Map();
    const aborts = /* @__PURE__ */ new Map();
    const installs = /* @__PURE__ */ new Map();
    let nextHandle = 1;
    const send = (m) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
    };
    const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
    const replyError = (id, e) => {
      if (e instanceof UnauthorizedError) send({ jsonrpc: "2.0", id, error: { code: BridgeErrorCode.unauthorized, message: e.message, data: { attempts: e.attempts } } });
      else if (e instanceof NoDevicesError) send({ jsonrpc: "2.0", id, error: { code: BridgeErrorCode.noDevices, message: e.message, data: { hint: e.hint } } });
      else send({ jsonrpc: "2.0", id, error: { code: BridgeErrorCode.internal, message: e instanceof Error ? e.message : String(e) } });
    };
    const device = (p) => {
      const d = devices.get(p.handle ?? -1);
      if (!d) throw Object.assign(new Error("unknown device handle"), { code: BridgeErrorCode.notFound });
      return d;
    };
    send({ jsonrpc: "2.0", method: "hello", params: { version: BRIDGE_PROTOCOL_VERSION, tool: o.version, brand: o.brand } });
    const handle = async (r) => {
      const p = r.params ?? {};
      switch (r.method) {
        case "hello":
          return reply(r.id, { version: BRIDGE_PROTOCOL_VERSION, tool: o.version, brand: o.brand });
        case "abort": {
          const id = Number(p["id"]);
          aborts.get(id)?.abort(new Error("aborted by client"));
          const job = installs.get(id);
          if (job) {
            job.ended = true;
            job.controller?.error(new Error("aborted by client"));
            job.wake?.();
            installs.delete(id);
          }
          return reply(r.id, true);
        }
        case "discover": {
          const ac = new AbortController();
          aborts.set(r.id, ac);
          try {
            const list = await o.transport.discover({ paths: p["paths"], subnet: p["subnet"], signal: ac.signal, onFound: (d) => send({ jsonrpc: "2.0", method: "found", params: { id: r.id, device: d } }) });
            reply(r.id, list);
          } finally {
            aborts.delete(r.id);
          }
          return;
        }
        case "connect": {
          const ac = new AbortController();
          aborts.set(r.id, ac);
          try {
            const d = await o.transport.connect(p["target"], { waitForAuth: Boolean(p["waitForAuth"]), signal: ac.signal, onUnauthorized: (n) => send({ jsonrpc: "2.0", method: "unauthorized", params: { id: r.id, attempt: n } }) });
            const h = nextHandle++;
            devices.set(h, d);
            reply(r.id, { handle: h, info: d.info, serial: d.serial });
          } finally {
            aborts.delete(r.id);
          }
          return;
        }
        case "pair":
          if (!o.transport.pair) throw new Error("this transport cannot pair");
          await o.transport.pair(String(p["hostPort"]), String(p["code"]));
          return reply(r.id, true);
        case "shell":
          return reply(r.id, await device(p).shell(String(p["cmd"])));
        case "authState":
          return reply(r.id, await device(p).authState());
        case "screencap":
          return reply(r.id, Buffer.from(await device(p).screencap()).toString("base64"));
        case "reboot":
          await device(p).reboot();
          return reply(r.id, true);
        case "tcpip": {
          const d = device(p);
          if (!d.openNetwork) throw new Error("this transport cannot open the network");
          const out = await d.openNetwork(p["port"] === void 0 ? void 0 : Number(p["port"]));
          devices.delete(Number(p["handle"]));
          void d.close().catch(() => {
          });
          return reply(r.id, out);
        }
        case "close": {
          const d = device(p);
          devices.delete(Number(p["handle"]));
          await d.close();
          return reply(r.id, true);
        }
        case "install": {
          const d = device(p);
          const job = { controller: void 0, queue: [], wake: void 0, ended: false };
          installs.set(r.id, job);
          const stream = new ReadableStream({
            start(c) {
              job.controller = c;
            },
            async pull(c) {
              for (; ; ) {
                const chunk = job.queue.shift();
                if (chunk) {
                  if (chunk.byteLength === 0) {
                    c.close();
                    return;
                  }
                  c.enqueue(chunk);
                  return;
                }
                if (job.ended) {
                  c.close();
                  return;
                }
                await new Promise((resolve) => job.wake = resolve);
                job.wake = void 0;
              }
            }
          });
          try {
            const out = await d.install(stream, { size: p["size"], name: p["name"] });
            reply(r.id, out);
          } finally {
            installs.delete(r.id);
          }
          return;
        }
        default:
          throw new Error(`unknown method ${String(r.method)}`);
      }
    };
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        const { id, chunk } = decodeBinaryFrame(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
        const job = installs.get(id);
        if (!job) return;
        job.queue.push(new Uint8Array(chunk));
        if (chunk.byteLength === 0) job.ended = true;
        job.wake?.();
        return;
      }
      let r;
      try {
        r = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof r.id !== "number" || typeof r.method !== "string") return;
      handle(r).catch((e) => replyError(r.id, e));
    });
    ws.on("close", () => {
      for (const ac of aborts.values()) ac.abort(new Error("client gone"));
      for (const d of devices.values()) d.close().catch(() => {
      });
      devices.clear();
      log("client disconnected");
    });
  });
  return {
    port,
    close: () => new Promise((resolve) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => resolve());
    })
  };
}

// apps/cli/src/cli.ts
import { parseArgs } from "node:util";
var COMMANDS = ["discover", "check", "provision", "install", "launcher", "configure", "test", "handover", "link", "screenshot", "pair", "report", "bridge", "mcp", "help", "version"];
var MOCK_SCENARIOS = ["happy", "unauthorized", "accounts", "nodevices"];
var MOCK_BOXES = ["googletv", "androidtv", "xiaomi", "other", "firetv"];
var PROFILES = ["kiosk", "open", "install-only"];
var ROLES = ["owner", "reseller"];
var METHODS = ["set-home-activity", "device-owner", "disable-stock"];
var UsageError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
};
function oneOf(name, value, allowed, fallback) {
  if (value === void 0) return fallback;
  if (allowed.includes(value)) return value;
  throw new UsageError(`--${name} must be one of ${allowed.join(", ")} (got "${value}")`);
}
function int(name, value) {
  if (value === void 0) return void 0;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || String(n) !== value.trim()) throw new UsageError(`--${name} must be an integer (got "${value}")`);
  return n;
}
function normalizeMock(argvIn) {
  const argv = argvIn.slice();
  while (argv[0] === "--") argv.shift();
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mock") {
      const next = argv[i + 1];
      if (next && MOCK_SCENARIOS.includes(next)) {
        out.push(`--mock=${next}`);
        i++;
      } else out.push("--mock=happy");
    } else out.push(a);
  }
  return out;
}
function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: normalizeMock(argv),
    strict: true,
    allowPositionals: true,
    allowNegative: true,
    options: {
      json: { type: "boolean", default: false },
      brand: { type: "string" },
      target: { type: "string" },
      mock: { type: "string" },
      box: { type: "string" },
      connect: { type: "string" },
      usb: { type: "boolean", default: false },
      serial: { type: "string" },
      profile: { type: "string" },
      lang: { type: "string", default: "en" },
      link: { type: "string" },
      "debug-off": { type: "boolean", default: true },
      yes: { type: "boolean", short: "y", default: false },
      manifest: { type: "string" },
      method: { type: "string" },
      out: { type: "string" },
      port: { type: "string" },
      role: { type: "string" },
      timeout: { type: "string" },
      subnet: { type: "string" },
      pin: { type: "string" },
      minutes: { type: "string" },
      "stop-before": { type: "string" },
      mcp: { type: "boolean", default: false },
      shell: { type: "boolean", default: true },
      check: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false }
    }
  });
  let command;
  const first = positionals[0];
  if (values.help) command = "help";
  else if (values.version) command = "version";
  else if (values.mcp) command = "mcp";
  else if (values.check) command = "check";
  else if (first === void 0) command = "help";
  else if (COMMANDS.includes(first)) command = first;
  else throw new UsageError(`unknown command "${first}" \u2014 one of ${COMMANDS.join(", ")}`);
  const brandValue = values.brand ?? process.env["TVLM_BRAND"];
  if (brandValue === "kiosk") throw new UsageError("the kiosk edition is gone \u2014 it is one tool now: use --target hotel (and --link CODE for the room)");
  if (brandValue !== void 0 && brandValue !== "launcher") throw new UsageError(`--brand must be launcher (got "${brandValue}")`);
  const brand = "launcher";
  const envTarget = process.env["TVLM_TARGET"];
  const targetValue = values.target ?? (envTarget && !envTarget.includes("${") ? envTarget : void 0);
  if (targetValue !== void 0 && !isTargetId(targetValue)) throw new UsageError(`--target must be launcher or hotel (got "${targetValue}")`);
  const target = targetValue ?? (values.link !== void 0 || values.profile === "kiosk" || values.role === "owner" ? "hotel" : "launcher");
  return {
    command,
    positionals: command === first ? positionals.slice(1) : positionals,
    json: values.json,
    brand,
    target,
    mock: values.mock === void 0 ? void 0 : oneOf("mock", values.mock, MOCK_SCENARIOS, "happy"),
    box: values.box === void 0 ? void 0 : oneOf("box", values.box, MOCK_BOXES, "xiaomi"),
    connect: values.connect,
    usb: values.usb,
    serial: values.serial,
    // The default profile is the target's own first profile: the product's launcher only does
    // `open`, the hotel launcher leads with `kiosk`. A fixed default would contradict brands/*.json.
    profile: values.profile === void 0 ? targetConfig(target).profiles[0] : oneOf("profile", values.profile, PROFILES, "kiosk"),
    lang: values.lang,
    link: values.link,
    debugOff: values["debug-off"],
    shell: values.shell,
    yes: values.yes,
    manifest: values.manifest,
    method: values.method === void 0 ? void 0 : oneOf("method", values.method, METHODS, "set-home-activity"),
    out: values.out,
    port: int("port", values.port),
    role: oneOf("role", values.role, ROLES, "reseller"),
    timeout: int("timeout", values.timeout),
    subnet: values.subnet,
    pin: values.pin,
    minutes: int("minutes", values.minutes),
    stopBefore: values["stop-before"] === void 0 ? void 0 : oneOf("stop-before", values["stop-before"], ["test", "handover"], "test"),
    help: values.help,
    version: values.version
  };
}
var USAGE = `tvlm \u2014 TV Box Tools / TV Launcher Manager CLI (one tool, every box)

Usage: tvlm <command> [options]

Commands
  discover                 find boxes: USB + mDNS + subnet scan (:5555)
  check                    read-only box facts (also: tvlm --check)
  provision                the automatic run: profile \u2192 install \u2192 launcher \u2192 configure \u2192 test \u2192 handover
  install                  install the manifest's APKs (SHA-256 verified, streamed)
  launcher                 make our launcher the HOME app (--method)
  configure                silent permission grants
  test                     HOME key \xB7 resolve \xB7 screenshot \xB7 reboot
  handover                 turn debugging off
  link CODE                send the LINK broadcast (owner)
  screenshot [--out f.png] PNG of the TV screen
  pair host:port CODE      Android 11+ wireless-debugging pairing (needs platform-tools adb)
  report [--out file]      the last session report
  bridge [--port 15555]    local WebSocket bridge for the web app (ws://127.0.0.1:15555)
  mcp  (or --mcp)          Model Context Protocol server on stdio, for AI agents (--no-shell: task tools only)

Target (check/provision/\u2026): --connect host:port | --usb | --serial X   (none = discover, one box expected)
Options: --target launcher|hotel (hotel = the hotel road; implied by --link, --role owner or --profile kiosk)
         --profile kiosk|open|install-only  --lang xx  --link CODE  --role owner|reseller
         --manifest URL|file  --method set-home-activity|device-owner|disable-stock  --no-debug-off
         --stop-before test|handover  --subnet 192.168.1.0/24  --port N  --timeout ms  --yes/-y  --json
         --mock [happy|unauthorized|accounts|nodevices] [--box googletv|androidtv|xiaomi|other|firetv]
`;

// apps/cli/src/mcp.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// apps/cli/src/session.ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir as mkdir2, readdir, readFile as readFile2, stat, writeFile as writeFile2 } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { join as join3 } from "node:path";
import { createInterface } from "node:readline/promises";
import { Readable } from "node:stream";

// packages/adb/src/node/credentials.ts
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { adbGeneratePublicKey } from "@yume-chan/adb";
var TVLM_DIR = join(homedir(), ".tvlm");
var ADB_KEY_PATH = join(TVLM_DIR, "adbkey");
var GOOGLE_ADB_KEY_PATH = join(homedir(), ".android", "adbkey");
function keyName() {
  let user = "tvlm";
  try {
    user = userInfo().username || user;
  } catch {
  }
  return `${user}@${hostname()}`;
}
function publicKeyLine(privateKeyPkcs8, name = keyName()) {
  const pub = adbGeneratePublicKey(privateKeyPkcs8);
  return `${Buffer.from(pub).toString("base64")} ${name}
`;
}
function pemToPkcs8(pem) {
  const der = createPrivateKey(pem).export({ type: "pkcs8", format: "der" });
  return new Uint8Array(der.buffer, der.byteOffset, der.byteLength);
}
async function loadKey(path, name) {
  try {
    const pem = await readFile(path, "utf8");
    return { buffer: pemToPkcs8(pem), name };
  } catch {
    return void 0;
  }
}
var NodeCredentialStore = class {
  constructor(path = ADB_KEY_PATH, extraPaths = [GOOGLE_ADB_KEY_PATH]) {
    this.path = path;
    this.extraPaths = extraPaths;
  }
  path;
  extraPaths;
  async generateKey() {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" });
    const buffer = pemToPkcs8(pem);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, pem, { mode: 384 });
    await writeFile(`${this.path}.pub`, publicKeyLine(buffer));
    return { buffer, name: keyName() };
  }
  /** Our key first (that is the one the Allow dialog shows), then Google adb's if present. */
  async *iterateKeys() {
    const own = await loadKey(this.path, keyName());
    if (own) yield own;
    for (const p of this.extraPaths) {
      const k = await loadKey(p, keyName());
      if (k) yield k;
    }
  }
  /** Make sure a key exists (so the first connect does not have to generate one mid-handshake). */
  async ensure() {
    for await (const k of this.iterateKeys()) return k;
    return this.generateKey();
  }
  /** PEM private keys + self-signed certs for TLS client auth, ours first. */
  async tlsIdentities() {
    const out = [];
    for (const p of [this.path, ...this.extraPaths]) {
      try {
        const pem = await readFile(p, "utf8");
        const key = createPrivateKey(pem);
        out.push({ key: key.export({ type: "pkcs8", format: "pem" }), cert: selfSignedCertificate(key), path: p });
      } catch {
      }
    }
    return out;
  }
};
function derLength(n) {
  if (n < 128) return [n];
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 255);
  return [128 | bytes.length, ...bytes];
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function tlv(tag, ...parts) {
  const body = concat(parts);
  return concat([Uint8Array.from([tag, ...derLength(body.length)]), body]);
}
var SEQ = 48;
var SET = 49;
function derOid(oid) {
  const parts = oid.split(".").map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const enc = [p & 127];
    for (let v = p >> 7; v > 0; v >>= 7) enc.unshift(128 | v & 127);
    bytes.push(...enc);
  }
  return tlv(6, Uint8Array.from(bytes));
}
function derInteger(bytes) {
  return tlv(2, bytes[0] & 128 ? concat([Uint8Array.from([0]), bytes]) : bytes);
}
function derUtcTime(d) {
  const s = d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z";
  return tlv(23, Buffer.from(s, "ascii"));
}
function derName(cn) {
  return tlv(SEQ, tlv(SET, tlv(SEQ, derOid("2.5.4.3"), tlv(12, Buffer.from(cn, "utf8")))));
}
var SHA256_RSA = tlv(SEQ, derOid("1.2.840.113549.1.1.11"), Uint8Array.from([5, 0]));
function selfSignedCertificate(privateKey, opts = {}) {
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const now = /* @__PURE__ */ new Date();
  const notBefore = new Date(now.getTime() - 864e5);
  const notAfter = new Date(now.getTime() + (opts.years ?? 10) * 365 * 864e5);
  const serial = opts.serial ?? randomBytes(16);
  const name = derName(opts.cn ?? "adb");
  const basicConstraints = tlv(
    SEQ,
    derOid("2.5.29.19"),
    Uint8Array.from([1, 1, 255]),
    // critical
    tlv(4, tlv(SEQ, Uint8Array.from([1, 1, 255])))
    // OCTET STRING { SEQUENCE { cA TRUE } }
  );
  const tbs = tlv(
    SEQ,
    tlv(160, tlv(2, Uint8Array.from([2]))),
    // [0] version v3
    derInteger(serial),
    SHA256_RSA,
    name,
    // issuer
    tlv(SEQ, derUtcTime(notBefore), derUtcTime(notAfter)),
    name,
    // subject
    new Uint8Array(spki.buffer, spki.byteOffset, spki.byteLength),
    tlv(163, tlv(SEQ, basicConstraints))
    // [3] extensions
  );
  const signature = sign("sha256", tbs, key);
  const cert = tlv(SEQ, tbs, SHA256_RSA, tlv(3, Uint8Array.from([0]), new Uint8Array(signature.buffer, signature.byteOffset, signature.byteLength)));
  const b64 = Buffer.from(cert).toString("base64").replace(/(.{64})/g, "$1\n").trimEnd();
  return `-----BEGIN CERTIFICATE-----
${b64}
-----END CERTIFICATE-----
`;
}

// packages/adb/src/node/discover.ts
import { createSocket } from "node:dgram";
import { connect as netConnect } from "node:net";
import { networkInterfaces } from "node:os";
var ADB_TLS_SERVICE = "_adb-tls-connect._tcp.local";
var ADB_TCP_SERVICE = "_adb._tcp.local";
var MDNS_ADDR = "224.0.0.251";
var MDNS_PORT = 5353;
var DEFAULT_ADB_PORT = 5555;
var DnsType = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 };
function encodeName(name) {
  const parts = name.replace(/\.$/, "").split(".").filter(Boolean);
  const out = [];
  for (const p of parts) {
    const b = Buffer.from(p, "utf8");
    if (b.length > 63) throw new Error(`label too long: ${p}`);
    out.push(b.length, ...b);
  }
  out.push(0);
  return Uint8Array.from(out);
}
function buildMdnsQuery(questions, opts = {}) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(opts.id ?? 0, 0);
  head.writeUInt16BE(0, 2);
  head.writeUInt16BE(questions.length, 4);
  const qs = questions.map((q) => {
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(q.type ?? DnsType.PTR, 0);
    tail.writeUInt16BE((opts.unicastResponse ? 32768 : 0) | 1, 2);
    return Buffer.concat([encodeName(q.name), tail]);
  });
  return new Uint8Array(Buffer.concat([head, ...qs]));
}
function readName(buf, offset, depth = 0) {
  const labels = [];
  let pos = offset;
  for (; ; ) {
    if (pos >= buf.length) throw new Error("dns: name runs past the packet");
    const len = buf[pos];
    if (len === 0) {
      pos++;
      return { name: labels.join("."), next: pos };
    }
    if ((len & 192) === 192) {
      if (depth > 16) throw new Error("dns: pointer loop");
      if (pos + 1 >= buf.length) throw new Error("dns: pointer runs past the packet");
      const ptr = (len & 63) << 8 | buf[pos + 1];
      const r = readName(buf, ptr, depth + 1);
      if (r.name) labels.push(r.name);
      return { name: labels.join("."), next: pos + 2 };
    }
    if (pos + 1 + len > buf.length) throw new Error("dns: label runs past the packet");
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString("utf8"));
    pos += 1 + len;
  }
}
function readRecord(buf, offset) {
  const { name, next } = readName(buf, offset);
  if (next + 10 > buf.length) throw new Error("dns: record header runs past the packet");
  const type = buf.readUInt16BE(next);
  const cls = buf.readUInt16BE(next + 2) & 32767;
  const ttl = buf.readUInt32BE(next + 4);
  const rdlen = buf.readUInt16BE(next + 8);
  const rd = next + 10;
  if (rd + rdlen > buf.length) throw new Error("dns: rdata runs past the packet");
  let data;
  switch (type) {
    case DnsType.PTR:
      data = readName(buf, rd).name;
      break;
    case DnsType.SRV:
      data = { priority: buf.readUInt16BE(rd), weight: buf.readUInt16BE(rd + 2), port: buf.readUInt16BE(rd + 4), target: readName(buf, rd + 6).name };
      break;
    case DnsType.A:
      data = rdlen === 4 ? `${buf[rd]}.${buf[rd + 1]}.${buf[rd + 2]}.${buf[rd + 3]}` : new Uint8Array(buf.subarray(rd, rd + rdlen));
      break;
    case DnsType.TXT: {
      const strings = [];
      for (let p = rd; p < rd + rdlen; ) {
        const l = buf[p];
        strings.push(buf.subarray(p + 1, p + 1 + l).toString("utf8"));
        p += 1 + l;
      }
      data = strings;
      break;
    }
    default:
      data = new Uint8Array(buf.subarray(rd, rd + rdlen));
  }
  return { rr: { name, type, cls, ttl, data }, next: rd + rdlen };
}
function parseDnsMessage(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 12) throw new Error("dns: short packet");
  const msg = { id: buf.readUInt16BE(0), flags: buf.readUInt16BE(2), questions: [], answers: [], authorities: [], additionals: [] };
  const counts = [buf.readUInt16BE(4), buf.readUInt16BE(6), buf.readUInt16BE(8), buf.readUInt16BE(10)];
  let pos = 12;
  for (let i = 0; i < counts[0]; i++) {
    const { name, next } = readName(buf, pos);
    if (next + 4 > buf.length) throw new Error("dns: question runs past the packet");
    msg.questions.push({ name, type: buf.readUInt16BE(next), cls: buf.readUInt16BE(next + 2) & 32767 });
    pos = next + 4;
  }
  const sections = [msg.answers, msg.authorities, msg.additionals];
  for (let s = 0; s < sections.length; s++) {
    for (let i = 0; i < counts[s + 1]; i++) {
      const { rr, next } = readRecord(buf, pos);
      sections[s].push(rr);
      pos = next;
    }
  }
  return msg;
}
function isSrv(d) {
  return typeof d === "object" && !Array.isArray(d) && !(d instanceof Uint8Array);
}
function collectAdbServices(messages) {
  const byInstance = /* @__PURE__ */ new Map();
  const hostIps = /* @__PURE__ */ new Map();
  const all = messages.flatMap((m) => [...m.answers, ...m.additionals, ...m.authorities]);
  for (const rr of all) if (rr.type === DnsType.A && typeof rr.data === "string") hostIps.set(rr.name.toLowerCase(), rr.data);
  for (const rr of all) {
    if (rr.type === DnsType.PTR && typeof rr.data === "string") {
      const svc = rr.name.toLowerCase();
      if (svc !== ADB_TLS_SERVICE && svc !== ADB_TCP_SERVICE) continue;
      const full = rr.data;
      const instance = full.slice(0, full.length - svc.length - 1);
      if (!byInstance.has(full.toLowerCase())) byInstance.set(full.toLowerCase(), { instance, service: svc });
    }
  }
  for (const rr of all) {
    if (rr.type === DnsType.SRV && isSrv(rr.data)) {
      const key = rr.name.toLowerCase();
      let s = byInstance.get(key);
      if (!s) {
        const svc = key.endsWith(ADB_TLS_SERVICE) ? ADB_TLS_SERVICE : key.endsWith(ADB_TCP_SERVICE) ? ADB_TCP_SERVICE : null;
        if (!svc) continue;
        s = { instance: rr.name.slice(0, rr.name.length - svc.length - 1), service: svc };
        byInstance.set(key, s);
      }
      s.port = rr.data.port;
      s.host = rr.data.target;
      s.ip = hostIps.get(rr.data.target.toLowerCase());
    }
  }
  return [...byInstance.values()];
}
var VIRTUAL_IFACE = /\b(tap|tun|vpn|wireguard|wg\d|zerotier|tailscale|docker|veth|vethernet|virtual|hyper-v|vmware|vbox|virtualbox|utun|ppp|bridge|br-|nordlynx|proton|npcap|loopback)\b/i;
function ipToInt(ip) {
  return ip.split(".").reduce((n, o) => (n << 8 | parseInt(o, 10) & 255) >>> 0, 0) >>> 0;
}
function intToIp(n) {
  return [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255].join(".");
}
function maskOf(prefix) {
  return prefix === 0 ? 0 : 4294967295 << 32 - prefix >>> 0;
}
function localSubnets(ifaces = networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list || VIRTUAL_IFACE.test(name)) continue;
    for (const a of list) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal || a.address.startsWith("169.254.") || a.address.startsWith("127.")) continue;
      const [o1, o2] = a.address.split(".").map((x) => parseInt(x, 10));
      if (o1 === 100 && o2 >= 64 && o2 <= 127) continue;
      const cidrPrefix = a.cidr ? parseInt(a.cidr.split("/")[1], 10) : 24;
      const prefix = Math.max(cidrPrefix, 24);
      const base = intToIp((ipToInt(a.address) & maskOf(prefix)) >>> 0);
      if (!out.some((s) => s.base === base && s.prefix === prefix)) out.push({ base, prefix, self: a.address, iface: name });
    }
  }
  return out;
}
function expandSubnet(s, exclude = []) {
  const size = 2 ** (32 - s.prefix);
  const start = ipToInt(s.base);
  const skip = new Set(exclude);
  const hosts = [];
  const from = s.prefix >= 31 ? 0 : 1;
  const to = s.prefix >= 31 ? size : size - 1;
  for (let i = from; i < to; i++) {
    const ip = intToIp(start + i >>> 0);
    if (!skip.has(ip)) hosts.push(ip);
  }
  return hosts;
}
function parseSubnet(text) {
  const [ip, p] = text.split("/");
  if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error(`bad subnet: ${text}`);
  const prefix = p ? parseInt(p, 10) : 24;
  if (!(prefix >= 16 && prefix <= 32)) throw new Error(`subnet prefix must be /16../32: ${text}`);
  return { base: intToIp((ipToInt(ip) & maskOf(prefix)) >>> 0), prefix };
}
function portOpen(host, port, timeoutMs, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const s = netConnect({ host, port });
    let settled = false;
    const done = (ok2) => {
      if (settled) return;
      settled = true;
      s.destroy();
      signal?.removeEventListener("abort", onAbort);
      resolve(ok2);
    };
    const onAbort = () => done(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}
async function parallelMap(items, concurrency, fn, signal) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (; ; ) {
      if (signal?.aborted) return;
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return results;
}
async function mdnsQuery(opts = {}) {
  const windowMs = opts.windowMs ?? 2e3;
  const ifaces = opts.interfaces ?? localSubnets().map((s) => s.self);
  const messages = [];
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, () => resolve());
  });
  socket.on("message", (m) => {
    try {
      const msg = parseDnsMessage(m);
      if (msg.flags & 32768) messages.push(msg);
    } catch {
    }
  });
  socket.on("error", () => {
  });
  const send = (packet, iface) => new Promise((resolve) => {
    try {
      if (iface) socket.setMulticastInterface(iface);
    } catch {
    }
    socket.send(packet, MDNS_PORT, MDNS_ADDR, () => resolve());
  });
  const targets = ifaces.length ? ifaces : [void 0];
  const query = buildMdnsQuery([{ name: ADB_TLS_SERVICE }, { name: ADB_TCP_SERVICE }], { unicastResponse: true });
  for (const i of targets) await send(query, i);
  const followUp = async () => {
    const svcs = collectAdbServices(messages).filter((s) => !s.port || !s.ip);
    if (!svcs.length) return;
    const qs = svcs.flatMap((s) => [{ name: `${s.instance}.${s.service}`, type: DnsType.SRV }, ...s.host ? [{ name: s.host, type: DnsType.A }] : []]);
    const q = buildMdnsQuery(qs, { unicastResponse: true });
    for (const i of targets) await send(q, i);
  };
  await new Promise((resolve) => {
    const half = setTimeout(() => void followUp(), Math.min(700, windowMs / 2));
    const end = setTimeout(resolve, windowMs);
    opts.signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(half);
        clearTimeout(end);
        resolve();
      },
      { once: true }
    );
  });
  socket.close();
  return collectAdbServices(messages);
}
async function discoverNetwork(opts = {}) {
  const port = opts.port ?? DEFAULT_ADB_PORT;
  const timeoutMs = opts.timeoutMs ?? 4e3;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("discover timeout")), timeoutMs);
  opts.signal?.addEventListener("abort", () => ac.abort(opts.signal?.reason), { once: true });
  const signal = ac.signal;
  const found = /* @__PURE__ */ new Map();
  const emit = (d) => {
    if (found.has(d.id)) return;
    found.set(d.id, d);
    opts.onFound?.(d);
  };
  const subnets = opts.subnet ? [{ ...parseSubnet(opts.subnet), self: "", iface: "arg" }] : localSubnets();
  const mine = /* @__PURE__ */ new Set([...localSubnets().map((s) => s.self).filter(Boolean), "127.0.0.1", "localhost"]);
  const mdnsTask = opts.mdns === false ? Promise.resolve() : mdnsQuery({ windowMs: Math.min(2e3, timeoutMs), signal, interfaces: subnets.map((s) => s.self).filter(Boolean) }).then((svcs) => {
    for (const s of svcs) {
      if (!s.ip || !s.port) continue;
      const tls = s.service === ADB_TLS_SERVICE;
      emit({ id: `${s.ip}:${s.port}`, name: s.instance, addr: `${s.ip}:${s.port}`, method: tls ? "wireless" : "tcp", ...tls ? { tls: true } : {}, ...mine.has(s.ip) ? { self: true } : {} });
    }
  }).catch(() => {
  });
  const scanTask = opts.scan === false ? Promise.resolve() : (async () => {
    const hosts = subnets.flatMap((s) => expandSubnet(s, s.self ? [s.self] : []));
    await parallelMap(
      hosts,
      opts.concurrency ?? 64,
      async (host) => {
        if (!await portOpen(host, port, opts.connectTimeoutMs ?? 300, signal)) return;
        if (found.has(`${host}:${port}`)) return;
        const c = opts.classify ? await opts.classify(host, port, signal).catch(() => null) : { method: "tcp" };
        if (!c) return;
        emit({ id: `${host}:${port}`, name: c.name ?? host, addr: `${host}:${port}`, method: c.method, ...c.method === "wireless" ? { tls: true } : {} });
      },
      signal
    );
  })();
  await Promise.all([mdnsTask, scanTask]);
  clearTimeout(timer);
  return [...found.values()];
}

// packages/adb/src/node/server.ts
import { AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";

// packages/adb/src/tango-device.ts
import { PackageManager } from "@yume-chan/android-bin";
var TangoDevice = class {
  constructor(info, adb, onClose) {
    this.info = info;
    this.adb = adb;
    this.onClose = onClose;
    adb.disconnected.then(
      () => this.#gone = true,
      () => this.#gone = true
    );
  }
  info;
  adb;
  onClose;
  #gone = false;
  get serial() {
    return this.adb.serial;
  }
  /** We only ever hand out authenticated devices; the only later state is "gone". */
  async authState() {
    return this.#gone ? "offline" : "authorized";
  }
  /**
   * `exec:` (raw, no pty): stdout+stderr as bytes, `\n` untouched — what the check parsers expect.
   * The command is passed as a single argv element so Tango's `splitCommand` never strips quotes.
   */
  async shell(cmd) {
    return this.adb.subprocess.noneProtocol.spawnWaitText([cmd]);
  }
  /** `pm install -r -S <size>` streamed over the socket (Android 7+), push+install below that. */
  async install(apk, opts = {}) {
    const pm = new PackageManager(this.adb);
    let stream = apk;
    let size = opts.size;
    if (size === void 0) {
      const chunks = [];
      const reader = apk.getReader();
      for (; ; ) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      size = chunks.reduce((n, c) => n + c.byteLength, 0);
      stream = new ReadableStream({
        pull(c) {
          const next = chunks.shift();
          if (next) c.enqueue(next);
          else c.close();
        }
      });
    }
    await pm.installStream(size, stream);
    return `Success${opts.name ? ` (${opts.name})` : ""}
`;
  }
  /**
   * ΠΟΛΛΑ APK ΣΕ ΜΙΑ ΣΥΝΕΔΡΙΑ — το base και τα κομμάτια ενός XAPK. `pm install-create` μία φορά,
   * ένα `install-write` ανά κομμάτι (με ρεύμα: κανένα αρχείο δεν γράφεται στον δίσκο του κουτιού),
   * `install-commit` στο τέλος. Σε οποιοδήποτε λάθος η συνεδρία ΕΓΚΑΤΑΛΕΙΠΕΤΑΙ: μια ανοιχτή
   * συνεδρία κρατά τα bytes της στο /data μέχρι να την καθαρίσει το σύστημα, μέρες μετά.
   */
  async installSplits(parts, opts = {}) {
    const pm = new PackageManager(this.adb);
    const session = await pm.sessionCreate({ skipExisting: false });
    try {
      for (const part of parts) {
        const stream = await part.open();
        await pm.sessionAddSplitStream(session, part.name.replace(/.*\//, ""), part.size, stream);
      }
      await pm.sessionCommit(session);
      return `Success${opts.name ? ` (${opts.name})` : ""}
`;
    } catch (e) {
      await pm.sessionAbandon(session).catch(() => {
      });
      throw e;
    }
  }
  /** Ένα αρχείο στο κουτί (sync write) — τα OBB ενός XAPK. Οι φάκελοι φτιάχνονται πρώτοι. */
  async pushFile(path, size, data) {
    const dir = path.replace(/\/[^/]*$/, "");
    if (dir) await this.shell(`mkdir -p '${dir}'`);
    const sync = await this.adb.sync();
    try {
      await sync.write({ filename: path, file: data });
      void size;
    } finally {
      await sync.dispose();
    }
  }
  /** `adb pull` over the sync service — one file, into memory (an APK is tens of megabytes). */
  async pull(path) {
    const sync = await this.adb.sync();
    try {
      const chunks = [];
      const reader = sync.read(path).getReader();
      for (; ; ) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      const size = chunks.reduce((n, c) => n + c.byteLength, 0);
      const out = new Uint8Array(size);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.byteLength;
      }
      return out;
    } finally {
      await sync.dispose();
    }
  }
  async screencap() {
    return this.adb.subprocess.noneProtocol.spawnWait(["screencap", "-p"]);
  }
  async reboot() {
    await this.adb.power.reboot();
  }
  /** Βλ. `tcpip.ts`: το adbd κάνει restart, άρα ΑΥΤΗ η σύνδεση πεθαίνει αμέσως μετά. */
  async openNetwork(port = 5555) {
    return openNetworkOn(this.adb, (c) => this.shell(c), port);
  }
  async close() {
    try {
      await this.adb.close();
    } finally {
      await this.onClose?.();
    }
  }
};
function isAuthRefusal(e) {
  return e instanceof Error && /No authenticator can handle|Connection closed unexpectedly/i.test(e.message);
}
async function authenticateWithAllow(start, opts, cleanup) {
  const tickMs = opts.tickMs ?? 2e3;
  const maxAttempts = opts.maxAttempts ?? 90;
  let attempt = 0;
  let pending = start();
  pending.catch(() => {
  });
  for (; ; ) {
    if (opts.signal?.aborted) {
      await cleanup();
      throw opts.signal.reason instanceof Error ? opts.signal.reason : new Error("aborted");
    }
    const outcome = await Promise.race([
      pending.then(
        (value) => ({ kind: "ok", value }),
        (error) => ({ kind: "err", error })
      ),
      new Promise((r) => setTimeout(() => r({ kind: "tick" }), tickMs)),
      new Promise((r) => opts.signal?.addEventListener("abort", () => r({ kind: "abort" }), { once: true }))
    ]);
    if (outcome.kind === "ok") return outcome.value;
    if (outcome.kind === "abort") {
      await cleanup();
      throw opts.signal?.reason instanceof Error ? opts.signal.reason : new Error("aborted");
    }
    attempt++;
    opts.onUnauthorized?.(attempt);
    if (outcome.kind === "err" && !isAuthRefusal(outcome.error)) {
      await cleanup();
      throw outcome.error;
    }
    if (!opts.waitForAuth || attempt >= maxAttempts) {
      await cleanup();
      throw new UnauthorizedError(attempt);
    }
    if (outcome.kind === "err") {
      await cleanup();
      pending = start();
      pending.catch(() => {
      });
    }
  }
}

// packages/adb/src/node/server.ts
var sleep2 = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener(
    "abort",
    () => {
      clearTimeout(t);
      resolve();
    },
    { once: true }
  );
});
var AdbServerUnavailableError = class extends Error {
  constructor(host, port) {
    super(`no adb server on ${host}:${port} (start it with \`adb start-server\`)`);
    this.host = host;
    this.port = port;
    this.name = "AdbServerUnavailableError";
  }
  host;
  port;
};
var AdbServerTransport = class {
  kind = "adb-server";
  supports = ["usb", "tcp", "wireless"];
  client;
  host;
  port;
  tickMs;
  constructor(o = {}) {
    this.host = o.host ?? "127.0.0.1";
    this.port = o.port ?? 5037;
    this.tickMs = o.tickMs ?? 2e3;
    this.client = new AdbServerClient(new AdbServerNodeTcpConnector({ host: this.host, port: this.port }));
  }
  /** Is a server listening? Never throws. */
  async available() {
    try {
      await this.client.getVersion();
      return true;
    } catch {
      return false;
    }
  }
  async discover() {
    if (!await this.available()) return [];
    const list = await this.client.getDevices(["device", "unauthorized", "offline"]);
    return list.map(toInfo);
  }
  async connect(target, opts = {}) {
    if (!await this.available()) throw new AdbServerUnavailableError(this.host, this.port);
    const serial = typeof target === "string" ? target : target.id;
    if (serial.includes(":")) {
      try {
        await this.client.wireless.connect(serial);
      } catch (e) {
        if (!(e instanceof AdbServerClient.AlreadyConnectedError)) throw e;
      }
    }
    let attempt = 0;
    for (; ; ) {
      if (opts.signal?.aborted) throw new Error("aborted");
      const devices = await this.client.getDevices(["device", "unauthorized", "offline"]);
      const d = devices.find((x) => x.serial === serial) ?? (serial === "" && devices.length === 1 ? devices[0] : void 0);
      if (!d) throw new NoDevicesError(devices.length ? "none" : "usb-driver");
      if (d.state === "device") {
        const adb = await this.client.createAdb({ serial: d.serial });
        const info = typeof target === "string" ? toInfo(d) : { ...target, name: target.name || d.model || d.serial };
        return new TangoDevice(info, adb);
      }
      attempt++;
      opts.onUnauthorized?.(attempt);
      if (!opts.waitForAuth || attempt >= 90) throw new UnauthorizedError(attempt);
      await sleep2(this.tickMs, opts.signal);
    }
  }
  /** `adb pair host:port code` through the server (it speaks SPAKE2 for us). */
  async pair(hostPort, code) {
    if (!await this.available()) throw new AdbServerUnavailableError(this.host, this.port);
    await this.client.wireless.pair(hostPort, code);
  }
};
function toInfo(d) {
  const net = d.serial.includes(":");
  return {
    id: d.serial,
    name: d.model?.replace(/_/g, " ") || d.product || d.serial,
    addr: net ? d.serial : `USB \xB7 ${d.serial}`,
    method: net ? "tcp" : "usb"
  };
}

// packages/adb/src/node/tcp.ts
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { connect as netConnect2 } from "node:net";
import { homedir as homedir2 } from "node:os";
import { delimiter, join as join2 } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { promisify } from "node:util";
import {
  Adb as Adb2,
  AdbBanner,
  AdbCommand,
  AdbDaemonTransport,
  AdbFeature,
  AdbPacket,
  AdbPacketSerializeStream,
  ADB_DAEMON_DEFAULT_FEATURES,
  calculateChecksum,
  decodeUtf8,
  encodeUtf8
} from "@yume-chan/adb";
import { Consumable, MaybeConsumable, PushReadableStream, StructDeserializeStream, pipeFrom, tryClose } from "@yume-chan/stream-extra";
var ADB_COMMAND_STLS = 1397511251;
var ADB_STLS_VERSION = 16777216;
var ADB_VERSION = 16777217;
var ADB_MAX_PAYLOAD = 1024 * 1024;
var OUR_FEATURES = ADB_DAEMON_DEFAULT_FEATURES.filter((f) => f !== AdbFeature.DelayedAck);
function bannerFor(features = OUR_FEATURES) {
  return encodeUtf8(`host::features=${features.join(",")}`);
}
function parseHostPort(text, defaultPort = 5555) {
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`bad address: ${text}`);
  return { host: m[1], port: m[2] ? parseInt(m[2], 10) : defaultPort };
}
function socketToConnection(socket) {
  socket.setNoDelay(true);
  const closed = new Promise((resolve) => socket.once("close", () => resolve()));
  const bytes = new PushReadableStream((controller) => {
    controller.abortSignal.addEventListener("abort", () => socket.destroy());
    socket.on("data", (data) => {
      if (controller.abortSignal.aborted) return;
      socket.pause();
      void controller.enqueue(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)).then(() => socket.resume()).catch(() => socket.destroy());
    });
    socket.once("end", () => tryClose(controller));
    socket.once("close", () => tryClose(controller));
    socket.once("error", (e) => {
      try {
        controller.error(e);
      } catch {
      }
    });
  });
  const readable = bytes.pipeThrough(new StructDeserializeStream(AdbPacket));
  const rawWritable = new MaybeConsumable.WritableStream({
    write: (chunk) => new Promise((resolve, reject) => {
      if (socket.destroyed) return reject(new Error("socket closed"));
      socket.write(chunk, (e) => e ? reject(e) : resolve());
    }),
    close: () => {
      socket.end();
    },
    abort: () => {
      socket.destroy();
    }
  });
  const writable = pipeFrom(rawWritable, new AdbPacketSerializeStream());
  return {
    socket,
    readable,
    writable,
    closed,
    destroy: () => socket.destroy()
  };
}
function openSocket(host, port, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const s = netConnect2({ host, port });
    const fail2 = (e) => {
      s.destroy();
      reject(e);
    };
    s.setTimeout(timeoutMs, () => fail2(new Error(`connect timeout ${host}:${port}`)));
    s.once("error", fail2);
    s.once("connect", () => {
      s.setTimeout(0);
      s.removeListener("error", fail2);
      resolve(s);
    });
    signal?.addEventListener("abort", () => fail2(new Error("aborted")), { once: true });
  });
}
async function sendPacket(conn, init) {
  const writer = conn.writable.getWriter();
  try {
    const full = { ...init, checksum: calculateChecksum(init.payload), magic: init.command ^ 4294967295 };
    await Consumable.WritableStream.write(writer, full);
  } finally {
    writer.releaseLock();
  }
}
async function readPacket(conn, timeoutMs) {
  const reader = conn.readable.getReader();
  let timer;
  try {
    const r = await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("no ADB reply (is this really an adb port?)")), timeoutMs);
      })
    ]);
    if (r.done) throw new Error("connection closed before the ADB handshake");
    return r.value;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
async function probeAdb(host, port, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 1500;
  let socket;
  try {
    socket = await openSocket(host, port, timeoutMs, opts.signal);
  } catch {
    return null;
  }
  const conn = socketToConnection(socket);
  try {
    await sendPacket(conn, { command: AdbCommand.Connect, arg0: ADB_VERSION, arg1: ADB_MAX_PAYLOAD, payload: bannerFor() });
    const p = await readPacket(conn, timeoutMs);
    if (p.command === AdbCommand.Connect) return { kind: "cnxn", banner: AdbBanner.parse(decodeUtf8(p.payload)), version: Math.min(ADB_VERSION, p.arg0), maxPayloadSize: Math.min(ADB_MAX_PAYLOAD, p.arg1) };
    if (p.command === AdbCommand.Auth) return { kind: "auth" };
    if (p.command === ADB_COMMAND_STLS) return { kind: "stls" };
    return null;
  } catch {
    return null;
  } finally {
    conn.destroy();
  }
}
var ADB_EXE = process.platform === "win32" ? "adb.exe" : "adb";
async function exists(p) {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
async function findPlatformToolsAdb() {
  const candidates = [join2(TVLM_DIR, "platform-tools", ADB_EXE)];
  for (const root of [process.env["ANDROID_HOME"], process.env["ANDROID_SDK_ROOT"]]) if (root) candidates.push(join2(root, "platform-tools", ADB_EXE));
  if (process.platform === "win32" && process.env["LOCALAPPDATA"]) candidates.push(join2(process.env["LOCALAPPDATA"], "Android", "Sdk", "platform-tools", ADB_EXE));
  if (process.platform === "darwin") candidates.push(join2(homedir2(), "Library", "Android", "sdk", "platform-tools", ADB_EXE));
  if (process.platform === "linux") candidates.push(join2(homedir2(), "Android", "Sdk", "platform-tools", ADB_EXE));
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) if (dir) candidates.push(join2(dir, ADB_EXE));
  for (const c of candidates) if (await exists(c)) return c;
  return null;
}
var PairingUnavailableError = class extends Error {
  constructor() {
    super(
      "Wireless-debugging pairing (SPAKE2) is done by Google's adb: put platform-tools in ~/.tvlm/platform-tools or on PATH, or pair once with `adb pair host:port code`. Boxes with plain ADB over TCP (Settings \u203A Developer options \u203A Network debugging / `adb tcpip 5555`) need no pairing."
    );
    this.name = "PairingUnavailableError";
  }
};
var NodeTcpTransport = class {
  kind = "node";
  supports = ["tcp", "wireless"];
  credentials;
  connectTimeoutMs;
  tickMs;
  constructor(o = {}) {
    this.credentials = o.credentials ?? new NodeCredentialStore();
    this.connectTimeoutMs = o.connectTimeoutMs ?? 4e3;
    this.tickMs = o.tickMs;
  }
  /** This transport does not enumerate by itself — `discoverNetwork` (mDNS + scan) does; see node/index.ts. */
  async discover() {
    return [];
  }
  async connect(target, opts = {}) {
    const info = typeof target === "string" ? { id: target, name: target, addr: target, method: "tcp" } : target;
    const { host, port } = parseHostPort(info.addr || info.id);
    await this.credentials.ensure();
    let tls = info.tls === true;
    if (!tls) {
      const probe = await probeAdb(host, port, { timeoutMs: this.connectTimeoutMs, signal: opts.signal });
      if (!probe) throw new Error(`${host}:${port}: no ADB daemon answered`);
      tls = probe.kind === "stls";
    }
    const adb = tls ? await this.connectTls(host, port, info, opts) : await this.connectPlain(host, port, info, opts);
    const resolved = { ...info, name: info.name === info.addr || info.name === info.id ? adb.banner.model ?? adb.banner.product ?? info.name : info.name, method: tls ? "wireless" : "tcp", ...tls ? { tls: true } : {} };
    return new TangoDevice(resolved, adb);
  }
  async connectPlain(host, port, info, opts) {
    let current;
    const start = async () => {
      current = socketToConnection(await openSocket(host, port, this.connectTimeoutMs, opts.signal));
      const transport = await AdbDaemonTransport.authenticate({ serial: info.id, connection: current, credentialStore: this.credentials, features: OUR_FEATURES, initialDelayedAckBytes: 0 });
      return new Adb2(transport);
    };
    return authenticateWithAllow(start, { ...opts, tickMs: this.tickMs }, () => current?.destroy());
  }
  /**
   * CNXN → STLS → (our STLS) → TLS 1.3 with a client cert over the paired/allowed key → the daemon sends
   * CNXN itself. A key adbd does not know fails the handshake: that is "unauthorized" here (pair first).
   */
  async connectTls(host, port, info, opts) {
    const identities = await this.credentials.tlsIdentities();
    let lastError;
    let attempt = 0;
    for (const id of identities) {
      if (opts.signal?.aborted) throw new Error("aborted");
      const raw = await openSocket(host, port, this.connectTimeoutMs, opts.signal);
      try {
        const plain = socketToConnection(raw);
        await sendPacket(plain, { command: AdbCommand.Connect, arg0: ADB_VERSION, arg1: ADB_MAX_PAYLOAD, payload: bannerFor() });
        const first = await readPacket(plain, this.connectTimeoutMs);
        if (first.command !== ADB_COMMAND_STLS) {
          plain.destroy();
          throw new Error(`${host}:${port} did not offer TLS (got 0x${first.command.toString(16)}) \u2014 connect it as a plain tcp target`);
        }
        await sendPacket(plain, { command: ADB_COMMAND_STLS, arg0: ADB_STLS_VERSION, arg1: 0, payload: new Uint8Array(0) });
        raw.removeAllListeners("data");
        raw.pause();
        const secure = await new Promise((resolve, reject) => {
          const t = tlsConnect({ socket: raw, key: id.key, cert: id.cert, rejectUnauthorized: false, minVersion: "TLSv1.3" }, () => resolve(t));
          t.once("error", reject);
        });
        const conn = socketToConnection(secure);
        const cnxn = await readPacket(conn, this.connectTimeoutMs);
        if (cnxn.command !== AdbCommand.Connect) throw new Error(`unexpected packet after TLS: 0x${cnxn.command.toString(16)}`);
        const transport = new AdbDaemonTransport({
          serial: info.id,
          connection: conn,
          version: Math.min(ADB_VERSION, cnxn.arg0),
          maxPayloadSize: Math.min(ADB_MAX_PAYLOAD, cnxn.arg1),
          banner: decodeUtf8(cnxn.payload),
          features: OUR_FEATURES,
          initialDelayedAckBytes: 0
        });
        return new Adb2(transport);
      } catch (e) {
        raw.destroy();
        lastError = e;
        attempt++;
        opts.onUnauthorized?.(attempt);
        if (!/tls|handshake|certificate|ECONNRESET|closed|EPIPE/i.test(e instanceof Error ? e.message : String(e))) throw e;
      }
    }
    if (identities.length === 0) throw new UnauthorizedError(0);
    throw Object.assign(new UnauthorizedError(attempt), { cause: lastError, hint: "not paired \u2014 run pair() with the code from Settings \u203A Developer options \u203A Wireless debugging" });
  }
  /** Android 11+ wireless debugging pairing via Google's adb (SPAKE2 is out of scope here). */
  async pair(hostPort, code) {
    if (!/^\d{6}$/.test(code)) throw new Error("pairing code is 6 digits");
    const adb = await findPlatformToolsAdb();
    if (!adb) throw new PairingUnavailableError();
    const { stdout, stderr } = await promisify(execFile)(adb, ["pair", hostPort, code], { timeout: 3e4, windowsHide: true }).catch((e) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? e.message }));
    const out = `${stdout}
${stderr}`;
    if (!/Successfully paired/i.test(out)) throw new Error(`pairing failed: ${out.trim() || "no output"}`);
  }
};

// packages/adb/src/node/usb.ts
import { Adb as Adb3, AdbDaemonTransport as AdbDaemonTransport2 } from "@yume-chan/adb";
import { AdbDaemonWebUsbDevice, AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
var UsbUnavailableError = class extends NoDevicesError {
  constructor(cause) {
    super("usb-driver");
    this.cause = cause;
    this.message = `USB is unavailable in this build: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  cause;
};
var NodeUsbTransport = class {
  kind = "node";
  supports = ["usb"];
  credentials;
  manager;
  tickMs;
  constructor(o = {}) {
    this.credentials = o.credentials ?? new NodeCredentialStore();
    this.tickMs = o.tickMs;
  }
  /** Loads the native module lazily, once; a failure is remembered as `UsbUnavailableError`. */
  async getManager() {
    this.manager ??= (async () => {
      try {
        const mod = await import("usb");
        const WebUSB = mod.WebUSB ?? mod.default?.WebUSB;
        if (!WebUSB) throw new Error("usb module has no WebUSB export");
        return new AdbDaemonWebUsbDeviceManager(new WebUSB({ allowAllDevices: true }));
      } catch (e) {
        throw new UsbUnavailableError(e);
      }
    })();
    return this.manager;
  }
  /**
   * The bus, as far as it can be read. An enumeration that throws (a device the driver will not
   * describe, a bus in a bad state) is reported as USB being unavailable — which is what it is
   * at that moment — so the caller falls back to the adb server instead of showing the driver's
   * error code to a person who plugged in nothing.
   */
  async list() {
    const manager = await this.getManager();
    try {
      return await manager.getDevices();
    } catch (e) {
      throw new UsbUnavailableError(e);
    }
  }
  /** Every attached USB device exposing the ADB interface (class 0xff / 0x42 / 1). */
  async discover() {
    const devices = await this.list();
    return devices.map(toInfo2);
  }
  async connect(target, opts = {}) {
    const serial = typeof target === "string" ? target : target.id;
    const devices = await this.list();
    const device = devices.find((d) => d.serial === serial) ?? (devices.length === 1 && serial === "" ? devices[0] : void 0);
    if (!device) throw new NoDevicesError(devices.length ? "none" : "usb-driver");
    const info = typeof target === "string" ? toInfo2(device) : target;
    await this.credentials.ensure();
    let connection;
    const start = async () => {
      try {
        connection = await device.connect();
      } catch (e) {
        if (e instanceof AdbDaemonWebUsbDevice.DeviceBusyError || /NetworkError|LIBUSB_ERROR_ACCESS|LIBUSB_ERROR_NOT_SUPPORTED|NOT_SUPPORTED|busy/i.test(String(e?.message))) throw new UsbUnavailableError(e);
        throw e;
      }
      const transport = await AdbDaemonTransport2.authenticate({ serial: device.serial, connection, credentialStore: this.credentials });
      return new Adb3(transport);
    };
    const adb = await authenticateWithAllow(start, { ...opts, tickMs: this.tickMs }, async () => {
      try {
        await device.raw.close();
      } catch {
      }
    });
    const named = { ...info, name: info.name || adb.banner.model || serial };
    return new TangoDevice(named, adb);
  }
};
function toInfo2(d) {
  const serial = d.serial || d.raw.serialNumber || "";
  return { id: serial, name: d.name || d.raw.productName || serial, addr: `USB \xB7 ${serial}`, method: "usb" };
}

// packages/adb/src/node/index.ts
var NodeTransport = class {
  kind = "node";
  supports = ["usb", "tcp", "wireless"];
  credentials;
  usb;
  tcp;
  server;
  /** Set after a discover/connect that found the `usb` module unusable — the UI's driver hint. */
  usbUnavailable;
  o;
  constructor(o = {}) {
    this.o = o;
    this.credentials = o.credentials ?? new NodeCredentialStore();
    this.usb = new NodeUsbTransport({ credentials: this.credentials, tickMs: o.tickMs });
    this.tcp = new NodeTcpTransport({ credentials: this.credentials, tickMs: o.tickMs });
    this.server = new AdbServerTransport({ tickMs: o.tickMs });
  }
  async discover(opts = {}) {
    const paths = opts.paths ?? this.supports;
    const found = /* @__PURE__ */ new Map();
    const emit = (d) => {
      if (found.has(d.id)) return;
      found.set(d.id, d);
      opts.onFound?.(d);
    };
    const tasks = [];
    if (paths.includes("usb")) {
      tasks.push(
        this.usb.discover().then((list) => list.forEach(emit)).catch(async (e) => {
          if (e instanceof UsbUnavailableError) this.usbUnavailable = e;
          if (this.o.adbServerFallback !== false) (await this.server.discover().catch(() => [])).filter((d) => d.method === "usb").forEach(emit);
        })
      );
    }
    if (paths.includes("tcp") || paths.includes("wireless")) {
      const net = {
        subnet: opts.subnet,
        port: this.o.port ?? DEFAULT_ADB_PORT,
        timeoutMs: this.o.discoverTimeoutMs ?? 4e3,
        signal: opts.signal,
        onFound: (d) => {
          if (paths.includes(d.method)) emit(d);
        },
        classify: async (host, port, signal) => {
          const p = await probeAdb(host, port, { timeoutMs: 1500, signal });
          if (!p) return null;
          if (p.kind === "stls") return { method: "wireless" };
          return { method: "tcp", name: p.kind === "cnxn" ? p.banner.model ?? p.banner.product ?? void 0 : void 0 };
        }
      };
      tasks.push(discoverNetwork(net).then(() => void 0));
    }
    await Promise.all(tasks);
    if (opts.signal?.aborted) return [...found.values()];
    if (found.size === 0) throw new NoDevicesError(paths.length === 1 && paths[0] === "usb" ? "usb-driver" : this.usbUnavailable && !paths.some((p) => p !== "usb") ? "usb-driver" : "client-isolation");
    return [...found.values()];
  }
  async connect(target, opts = {}) {
    const info = typeof target === "string" ? guessInfo(target) : target;
    if (info.method === "usb") {
      try {
        return await this.usb.connect(info, opts);
      } catch (e) {
        if (e instanceof UsbUnavailableError && this.o.adbServerFallback !== false && await this.server.available()) {
          this.usbUnavailable = e;
          return this.server.connect(info, opts);
        }
        throw e;
      }
    }
    return this.tcp.connect(info, opts);
  }
  async pair(hostPort, code) {
    try {
      await this.tcp.pair(hostPort, code);
    } catch (e) {
      if (await this.server.available()) return this.server.pair(hostPort, code);
      throw e;
    }
  }
};
function guessInfo(target) {
  const t = target.trim();
  if (/^[\w.-]+:\d+$/.test(t) || /^\d+\.\d+\.\d+\.\d+$/.test(t)) {
    const { host, port } = parseHostPort(t);
    const addr = `${host}:${port}`;
    return { id: addr, name: addr, addr, method: "tcp" };
  }
  return { id: t, name: t, addr: `USB \xB7 ${t}`, method: "usb" };
}
function createNodeTransport(o = {}) {
  return new NodeTransport(o);
}

// apps/cli/src/session.ts
function defaultIo() {
  return {
    out: (s) => process.stdout.write(s + "\n"),
    err: (s) => process.stderr.write(s + "\n"),
    isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    ask: async (q) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(q);
      } finally {
        rl.close();
      }
    }
  };
}
var REPORTS_DIR = join3(homedir3(), ".tvlm", "reports");
function createTransport(o) {
  if (o.mock) return new MockTransport({ speed: 0, scenario: o.mock, box: o.box ?? "xiaomi", launcherPackage: targetConfig(o.target).launcherPackage });
  return createNodeTransport({ port: o.port, discoverTimeoutMs: o.timeout });
}
async function pickDevice(transport, o, io, signal) {
  let target;
  if (o.connect) target = o.connect;
  else if (o.serial) target = { id: o.serial, name: o.serial, addr: `USB \xB7 ${o.serial}`, method: "usb" };
  else {
    const list = await transport.discover({ paths: o.usb ? ["usb"] : void 0, subnet: o.subnet, signal });
    if (list.length === 0) throw new NoDevicesError("none");
    if (list.length > 1 && transport.kind !== "mock") {
      if (!o.yes) throw new Error(`several boxes found \u2014 pick one with --connect/--serial:
${list.map((d) => `  ${d.addr}  ${d.name}`).join("\n")}`);
      io.err(`several boxes; --yes takes the first: ${list[0].addr}`);
    }
    target = list[0];
  }
  io.err(`connecting to ${typeof target === "string" ? target : target.addr} \u2026 (press Allow on the TV if asked)`);
  return transport.connect(target, {
    waitForAuth: true,
    signal,
    onUnauthorized: (n) => io.err(n === 1 ? "waiting for Allow on the TV\u2026" : n === 3 ? 'still waiting \u2014 on the TV tick "Always allow" and press Allow' : `waiting\u2026 (${n})`)
  });
}
var ReconnectingShell = class {
  constructor(current) {
    this.current = current;
  }
  current;
  shell(cmd) {
    return this.current.shell(cmd);
  }
  install(apk, opts) {
    return this.current.install(apk, opts);
  }
  screencap() {
    return this.current.screencap();
  }
  swap(d) {
    this.current = d;
  }
};
async function sha256Stream(stream) {
  const h = createHash("sha256");
  const reader = stream.getReader();
  for (; ; ) {
    const { value, done } = await reader.read();
    if (done) break;
    h.update(value);
  }
  return h.digest("hex");
}
async function fetchApk(url) {
  if (/^https?:/i.test(url)) {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${url}`);
    const len = res.headers.get("content-length");
    return { stream: res.body, size: len ? parseInt(len, 10) : void 0 };
  }
  const path = url.startsWith("file://") ? new URL(url) : url;
  const size = (await stat(path)).size;
  return { stream: Readable.toWeb(createReadStream(path)), size };
}
async function loadManifest(o, brand) {
  if (o.mock && !o.manifest) return mockManifest(brand);
  const src = o.manifest ?? brand.manifestUrl;
  let text;
  if (/^https?:/i.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`manifest: ${res.status} ${src}`);
    text = await res.text();
  } else text = await readFile2(src.startsWith("file://") ? new URL(src) : src, "utf8");
  return validateManifest(JSON.parse(text));
}
var MOCK_APK_BYTES = new Uint8Array([80, 75, 3, 4, 116, 118, 108, 109, 0, 0]);
var MOCK_APK_URL = "mock://apk";
function mockManifest(brand) {
  const sha256 = createHash("sha256").update(MOCK_APK_BYTES).digest("hex");
  return {
    schema: 1,
    tool: { version: TOOL_VERSION, minVersion: TOOL_VERSION, downloads: {}, sha256: {} },
    apps: [
      { pkg: brand.launcherPackage, name: brand.launcherName, url: MOCK_APK_URL, sha256, versionCode: 1002, required: true, role: ["owner", "reseller"] },
      { pkg: "com.tv.setup.suite", name: "TVS \u2014 TV Setup Suite", url: MOCK_APK_URL, sha256, versionCode: 1069, required: true, role: ["owner", "reseller"] },
      { pkg: "io.github.jqssun.airplay", name: "AirPlay receiver", url: MOCK_APK_URL, sha256, versionCode: 31, required: true, role: ["owner", "reseller"], group: "airplay", license: "GPL-3.0" }
    ]
  };
}
function createSession(o) {
  const report = new SessionReport({ brand: o.brand.id, tool: o.brand.cli, version: TOOL_VERSION, startedAt: Date.now(), device: { serial: o.device.serial, model: o.device.info.name, addr: o.device.info.addr } });
  const shell = new ReconnectingShell(o.device);
  const humanActions = [];
  const session = { brand: o.brand, device: o.device, shell, report, humanActions, rebooted: false, engine: void 0 };
  session.engine = new ProvisionEngine({
    brand: o.brand,
    shell,
    report,
    confirm: async (cmd, step) => {
      if (o.confirm) return o.confirm(cmd, step);
      if (o.autoConfirm) return true;
      if (!o.io.isTTY) {
        o.io.err(`skipped (needs confirmation, no TTY \u2014 use --yes): ${cmd}`);
        return false;
      }
      const a = await o.io.ask(`run on the TV?  ${cmd}
[y/N] `);
      return /^y(es)?$/i.test(a.trim());
    },
    human: async (what, step) => {
      humanActions.push({ what, step: step.id });
      if (step.id === "test.reboot") session.rebooted = true;
      if (o.human) return o.human(what, step);
      const text = { allow: "the box reboots \u2014 when it is back, press Allow on the TV if it asks again", home: "press HOME on the remote", pickLauncher: 'on the TV pick our launcher and "Always"', accounts: "remove the Google account on the TV (Settings \u203A Accounts)", reboot: "the box is restarting \u2014 wait for the picture to come back" }[what];
      o.io.err(`\u2192 on the TV: ${text}`);
      if (o.io.isTTY && !o.autoConfirm) await o.io.ask("press Enter when done ");
    },
    fetchApk: o.mock ? async () => ({ stream: new Blob([MOCK_APK_BYTES]).stream(), size: MOCK_APK_BYTES.byteLength }) : fetchApk,
    sha256: sha256Stream,
    onEvent: (e) => {
      o.onEvent?.(e);
      if (!o.verbose) return;
      if (e.type === "task:start") o.io.err(`== ${e.task}`);
      else if (e.type === "step:start") o.io.err(`$ ${e.cmd}   (${e.verdict})`);
      else if (e.type === "step:done") o.io.err(e.ok ? `  ok` : `  FAILED: ${e.output.trim().split("\n")[0] ?? ""}`);
      else if (e.type === "install:app") o.io.err(`  ${e.phase} ${e.app.name}${e.detail ? ` \u2014 ${e.detail}` : ""}`);
      else if (e.type === "log") o.io.err(`  [${e.kind}] ${e.text}`);
      else if (e.type === "task:done") o.io.err(`== ${e.task}: ${e.ok ? "done" : "failed"}`);
    }
  });
  return session;
}
function stepContext(o, brand, check) {
  return {
    brand,
    profile: brand.profiles.includes(o.profile) ? o.profile : brand.profiles[0] ?? "open",
    lang: o.lang,
    stockLauncher: check?.stockLauncher ?? null,
    linkCode: o.link,
    pin: o.pin,
    minutes: o.minutes,
    debugOff: brand.debugOffAtHandover && o.debugOff
  };
}
async function reconnectAfterReboot(session, transport, io, opts = {}) {
  const deadline = Date.now() + (opts.timeoutMs ?? 15e4);
  const info = session.device.info;
  io.err("waiting for the box to reboot\u2026");
  await new Promise((r) => setTimeout(r, transport.kind === "mock" ? 0 : 15e3));
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return false;
    try {
      const d = await transport.connect(info, { waitForAuth: true, signal: opts.signal, onUnauthorized: (n) => n === 1 && io.err("press Allow on the TV again") });
      session.shell.swap(d);
      session.device = d;
      session.rebooted = false;
      io.err("reconnected");
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, transport.kind === "mock" ? 0 : 3e3));
    }
  }
  return false;
}
async function saveReport(report) {
  await mkdir2(REPORTS_DIR, { recursive: true });
  const stamp = new Date(report.meta.startedAt).toISOString().replace(/[:.]/g, "-");
  const serial = (report.meta.device?.serial ?? "nodevice").replace(/[^\w.-]/g, "_");
  const base = join3(REPORTS_DIR, `${stamp}-${serial}`);
  await writeFile2(`${base}.json`, JSON.stringify(report.toJSON(), null, 2));
  await writeFile2(`${base}.txt`, report.toText());
  return base;
}
async function latestReport() {
  let names;
  try {
    names = (await readdir(REPORTS_DIR)).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return null;
  }
  const last = names.at(-1);
  if (!last) return null;
  const path = join3(REPORTS_DIR, last);
  return { path, json: await readFile2(path, "utf8"), text: await readFile2(path.replace(/\.json$/, ".txt"), "utf8").catch(() => "") };
}

// apps/cli/src/mcp.ts
var tool = (def) => def;
var ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
var fail = (data) => ({ isError: true, content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
var errInfo = (e) => ({
  error: e instanceof Error ? e.message : String(e),
  kind: e instanceof UnauthorizedError ? "unauthorized" : e instanceof NoDevicesError ? `no-devices:${e.hint}` : "error",
  ...e instanceof UnauthorizedError ? { next: 'Tell the human to press Allow on the TV ("Always allow from this computer"), then call connect again.' } : {},
  ...e instanceof NoDevicesError ? { next: e.hint === "usb-driver" ? "USB: is it a data cable, is USB debugging on, does Windows need a driver? Or use Wi-Fi." : "Wi-Fi: same network as the TV? Guest/hotel networks isolate clients \u2014 use the phone hotspot or USB. Is Network debugging on (Android 11+: Wireless debugging \u2192 pair first)?" } : {}
});
function stepPlan(ctx, tasks, method) {
  return tasks.filter((t) => t !== "install").map((task) => ({
    task,
    steps: stepsFor({ task, homeMethod: task === "launcher" ? method : void 0 }, ctx).map((s) => {
      const cmd = renderCommand(s, ctx);
      return { id: s.id, cmd, verdict: classifyCommand(cmd, { handoverLastStep: s.handoverLastStep }).verdict };
    })
  }));
}
function createTools(ctx) {
  const { brand, transport } = ctx;
  const io = { out: () => {
  }, err: (m) => ctx.log?.(m), isTTY: false, ask: async () => "" };
  let session;
  let lastCheck;
  let manifest;
  let allowConfirm = false;
  const need = () => {
    if (!session) throw new Error("not connected \u2014 call connect first (discover lists the boxes)");
    return session;
  };
  const sanctioned = async (fn) => {
    allowConfirm = true;
    try {
      return await fn();
    } finally {
      allowConfirm = false;
    }
  };
  const getManifest = async (url) => {
    if (url || !manifest) manifest = await loadManifest({ manifest: url, mock: ctx.mock ? "happy" : void 0 }, brand);
    return manifest;
  };
  const ctxFor = (a) => stepContext({ profile: a.profile ?? brand.profiles[0] ?? "open", lang: a.lang ?? "en", link: a.linkCode, debugOff: a.debugOff ?? true }, brand, lastCheck ?? null);
  const reconnectIfRebooted = async () => {
    const s = need();
    if (s.rebooted && !await reconnectAfterReboot(s, transport, io)) throw new Error("the box did not come back after the reboot \u2014 wait and call connect again");
  };
  const order = autoRunOrder(brand);
  const tools = {
    discover: tool({
      title: "Find TV boxes",
      readOnly: true,
      description: `Find Android TV boxes reachable from this computer: USB (adb interface), mDNS (_adb._tcp / _adb-tls-connect._tcp) and a TCP scan of the local /24 on :5555. Takes a few seconds. BEFORE calling: the human must have enabled Developer options on the TV (Settings \u203A Device Preferences \u203A About \u203A Build \xD77) and USB debugging or Network/Wireless debugging. Returns DeviceInfo[] \u2014 pass one's "id" (or "host:port") to connect. method "wireless" with tls=true is Android 11+ Wireless debugging: call pair first with the code shown on the TV. Empty list: same Wi-Fi as the TV? Hotel/guest networks isolate clients (use the phone hotspot or USB). ${brand.fireTv === "blocked" ? "Fire TV is not supported by this brand." : "Fire TV: Settings \u203A My Fire TV \u203A About \u203A device name \xD77, then ADB debugging."}`,
      inputSchema: {
        paths: z.array(z.enum(["usb", "tcp", "wireless"])).optional().describe("Limit to these paths; default all"),
        subnet: z.string().optional().describe("Scan this range instead of the local /24s, e.g. 192.168.1.0/24")
      },
      handler: async (a) => {
        try {
          const list = await transport.discover({ paths: a.paths, subnet: a.subnet });
          return ok({ devices: list, next: "call connect with a device id" });
        } catch (e) {
          if (e instanceof NoDevicesError) return ok({ devices: [], ...errInfo(e) });
          return fail(errInfo(e));
        }
      }
    }),
    pair: tool({
      title: "Pair (Android 11+ wireless debugging)",
      description: 'Only for Android 11+ "Wireless debugging" (discover shows tls=true). On the TV: Developer options \u203A Wireless debugging \u203A "Pair device with pairing code" shows host:port and a 6-digit code \u2014 ask the human for both. Not needed for USB or classic Network debugging (:5555). Needs Google platform-tools adb on this computer.',
      inputSchema: { hostPort: z.string().describe("The PAIRING host:port shown on the TV (not the connect port)"), code: z.string().regex(/^\d{6}$/).describe("6-digit pairing code") },
      handler: async (a) => {
        try {
          if (!transport.pair) throw new Error("this transport cannot pair");
          await transport.pair(a.hostPort, a.code);
          return ok({ paired: a.hostPort, next: "call discover, then connect to the wireless device" });
        } catch (e) {
          return fail(errInfo(e));
        }
      }
    }),
    connect: tool({
      title: "Connect to a box",
      description: `Open the ADB session to one box. target = a device id from discover, "host:port" (Wi-Fi), or a USB serial. The FIRST time, the TV shows "Allow USB debugging?": tell the human to tick "Always allow from this computer" and press Allow \u2014 this call waits up to waitSeconds for that (default 60). On "unauthorized" ask the human to press Allow and call connect again. Replaces any previous session. After connecting call check.`,
      inputSchema: { target: z.string().describe("device id / host:port / serial"), waitSeconds: z.number().int().min(0).max(600).optional() },
      handler: async (a) => {
        try {
          if (session) await session.device.close().catch(() => {
          });
          session = void 0;
          lastCheck = void 0;
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(new Error("timed out waiting for Allow")), (a.waitSeconds ?? 60) * 1e3);
          let attempts = 0;
          let device;
          try {
            device = await transport.connect(a.target, { waitForAuth: true, signal: ac.signal, onUnauthorized: (n) => attempts = n });
          } finally {
            clearTimeout(timer);
          }
          session = createSession({
            brand,
            device,
            io,
            autoConfirm: false,
            mock: Boolean(ctx.mock),
            confirm: async () => allowConfirm,
            // read at call time
            human: async () => {
            }
            // recorded in humanActions; the agent relays them
          });
          session.transport = transport;
          return ok({ connected: true, device: device.info, serial: device.serial, allowAttempts: attempts, next: "call check" });
        } catch (e) {
          return fail(errInfo(e));
        }
      }
    }),
    check: tool({
      title: "Check the box (read-only)",
      readOnly: true,
      description: `Read-only facts about the connected box: model, Android version, platform (googletv/androidtv/firetv/other), Google accounts, free space, whether ${brand.launcherName} (${brand.launcherPackage}) is installed and its versionCode, the current HOME app, device owner, developer options / adb state. Run it after connect and again after provision to verify. ${brand.flow === "kiosk" ? "Kiosk profile REQUIRES accounts=[] (device owner cannot be set with a Google account present \u2014 the human removes it in Settings \u203A Accounts) and platform != firetv." : ""} Only allowlisted commands run (getprop, dumpsys, pm list, settings get, df, cmd package resolve-activity).`,
      inputSchema: {},
      handler: async () => {
        try {
          await reconnectIfRebooted();
          lastCheck = await need().engine.check();
          const warnings = [];
          if (brand.flow === "kiosk" && lastCheck.accounts.length) warnings.push(`accounts present (${lastCheck.accounts.join(", ")}) \u2014 kiosk (device owner) will be refused; remove them on the TV or use profile "open"`);
          if (brand.fireTv === "blocked" && lastCheck.platform === "firetv") warnings.push("Fire TV is not supported by this brand");
          if (!lastCheck.isTv) warnings.push("this does not look like a TV build");
          return ok({ check: lastCheck, warnings, next: lastCheck.launcherInstalled ? "the launcher is installed \u2014 provision (or launcher/configure) to finish, or test to verify" : "call provision (everything) or install" });
        } catch (e) {
          return fail(errInfo(e));
        }
      }
    }),
    install: tool({
      title: "Install the apps",
      destructive: true,
      description: `Download the brand manifest (${brand.manifestUrl}, or manifestUrl), verify each APK's SHA-256 and stream it into "pm install -r" on the box \u2014 nothing is stored on this computer. Installs the required apps for the role (owner|reseller): ${brand.launcherName}, TVS, one AirPlay receiver. Up-to-date apps are skipped. Needs internet on this computer.`,
      inputSchema: { role: z.enum(["owner", "reseller"]).default("reseller"), manifestUrl: z.string().optional().describe("override: URL or local path of manifest.json") },
      handler: async (a) => {
        try {
          await reconnectIfRebooted();
          const s = need();
          const m = await getManifest(a.manifestUrl);
          const installed = lastCheck ? new Map(lastCheck.installedPackages.map((p) => [p, null])) : void 0;
          const done = await sanctioned(() => s.engine.install(m, a.role, { installed }));
          return done ? ok({ ok: true, apps: m.apps.map((x) => x.pkg), next: "call check, then launcher/configure or provision" }) : fail({ ok: false, reportTail: s.report.toText().split("\n").slice(-12) });
        } catch (e) {
          return fail(errInfo(e));
        }
      }
    }),
    provision: tool({
      title: "Provision (the automatic run)",
      destructive: true,
      description: `The whole setup in the brand's order: ${order.join(" \u2192 ")}. ${brand.flow === "kiosk" ? "profile: kiosk (device owner + persistent HOME, guests cannot leave), open (accessibility HOME, adb stays on), install-only." : "This brand has one flow (profile is ignored): install \u2192 disable the stock launcher + set HOME \u2192 grants \u2192 test."} lang = the launcher UI language. linkCode = the owner's 8-digit code (owner role only; resellers provision WITHOUT link). debugOff = turn ADB off as the very last step (brand default ${brand.debugOffAtHandover ? "on" : "off"}) \u2014 after it you lose the connection, so do it last. IMPORTANT: "test" REBOOTS the box and "handover" turns debugging off; pass stopBefore:"test" to keep the session for screenshots/checks and run test/handover later. Every command runs through the same gate as the UI and is written to the report. Returns per-task true/false/null(not reached) and humanActions the human must do on the TV (pick the launcher, press Allow again after the reboot). Ask the human only for Allow / HOME / picking the launcher \u2014 never paste commands to them. dryRun lists the commands without running.`,
      inputSchema: {
        profile: z.enum(["kiosk", "open", "install-only"]).optional(),
        lang: z.string().default("en"),
        linkCode: z.string().optional(),
        role: z.enum(["owner", "reseller"]).default("reseller"),
        debugOff: z.boolean().optional(),
        stopBefore: z.enum(["test", "handover"]).optional(),
        homeMethod: z.enum(["set-home-activity", "device-owner", "disable-stock"]).optional().describe(`default = the brand's first: ${brand.homeMethods[0]}`),
        manifestUrl: z.string().optional(),
        dryRun: z.boolean().default(false)
      },
      handler: async (a) => {
        try {
          const s = need();
          if (!lastCheck) lastCheck = await s.engine.check();
          const sc = ctxFor({ profile: a.profile, lang: a.lang, linkCode: a.linkCode, debugOff: a.debugOff ?? brand.debugOffAtHandover });
          const tasks = a.stopBefore ? order.slice(0, order.indexOf(a.stopBefore)) : order.slice();
          if (a.dryRun) return ok({ dryRun: true, profile: sc.profile, plan: stepPlan(sc, tasks, a.homeMethod), install: tasks.includes("install") ? "from the manifest" : "no" });
          if (brand.flow === "kiosk" && sc.profile === "kiosk" && lastCheck.accounts.length) return fail({ ok: false, reason: `Google account present (${lastCheck.accounts.join(", ")}): kiosk needs none. Ask the human to remove it (Settings \u203A Accounts) or use profile "open".` });
          const result = { profile: null, install: null, launcher: null, configure: null, test: null, handover: null, maintenance: null };
          await sanctioned(async () => {
            for (const task of tasks) {
              await reconnectIfRebooted();
              if (task === "install") {
                const m = await getManifest(a.manifestUrl);
                result.install = await s.engine.install(m, a.role, { installed: new Map(lastCheck.installedPackages.map((p) => [p, null])) });
                if (!result.install) break;
                continue;
              }
              result[task] = await s.engine.runTask(task, sc, task === "launcher" ? a.homeMethod : void 0);
              if (!result[task] && task !== "configure" && task !== "test") break;
            }
          });
          const ran = Object.entries(result).filter(([, v]) => v !== null);
          const allOk = ran.every(([, v]) => v === true);
          const out = {
            ok: allOk,
            profile: sc.profile,
            tasks: result,
            humanActions: s.humanActions.splice(0),
            rebooted: s.rebooted,
            next: allOk ? a.stopBefore ? `stopped before ${a.stopBefore} \u2014 call test (reboots) and then handover when ready` : s.rebooted ? "the box is rebooting: wait ~60 s, call connect and check to verify" : "call check to verify" : "see report; fix and call the failing task tool (launcher/configure/test) or provision again"
          };
          return allOk ? ok(out) : fail({ ...out, reportTail: s.report.toText().split("\n").slice(-15) });
        } catch (e) {
          return fail(errInfo(e));
        }
      }
    }),
    link: tool({
      title: "Link the box to the owner account",
      description: `Send the LINK broadcast to ${brand.launcherName} with the 8-digit code from the owner's account page (${brand.domain}). Owner role only \u2014 resellers hand over without a link; the owner links later. The launcher must be installed first.`,
      inputSchema: { code: z.string().min(4).max(16) },
      handler: async (a) => {
        try {
          await reconnectIfRebooted();
          const s = need();
          const sc = { ...ctxFor({}), linkCode: a.code };
          const step = stepsFor({ task: "profile" }, sc).find((x) => x.id === "profile.link");
          if (!step) return fail({ ok: false, reason: "this brand has no link step" });
          const r = await sanctioned(() => s.engine.exec(renderCommand(step, sc), { stepId: step.id }));
          const done = r.ran && /Broadcast completed/i.test(r.output);
          return done ? ok({ ok: true, code: a.code }) : fail({ ok: false, output: r.output.trim() });
        } catch (e) {
          return fail(errInfo(e));
        }
      }
    }),
    test: tool({
      title: "Test the setup (reboots the box)",
      destructive: true,
      description: "HOME key \u2192 resolve the HOME app \u2192 screenshot on the box \u2192 REBOOT. After it the connection drops: wait about 60 s, call connect again, then check (does our launcher come back as HOME after a reboot? \u2014 that is what breaks most often). The human may need to press Allow again after the reboot.",
      inputSchema: {},
      handler: async () => {
        try {
          await reconnectIfRebooted();
          const s = need();
          const done = await sanctioned(() => s.engine.runTask("test", ctxFor({})));
          return (done ? ok : fail)({ ok: done, humanActions: s.humanActions.splice(0), next: "wait ~60 s for the reboot, then connect + check" });
        } catch (e) {
          return fail(errInfo(e));
        }
      }
    }),
    screenshot: tool({
      title: "Screenshot of the TV",
      readOnly: true,
      description: "PNG of what the TV shows right now (image content). Use it to confirm the launcher is on screen, or to see which dialog the box is waiting on (Allow, pick launcher).",
      inputSchema: {},
      handler: async () => {
        try {
          await reconnectIfRebooted();
          const png = await need().device.screencap();
          return { content: [{ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" }, { type: "text", text: JSON.stringify({ bytes: png.byteLength }) }] };
        } catch (e) {
          return fail(errInfo(e));
        }
      }
    }),
    report: tool({
      title: "Session report",
      readOnly: true,
      local: true,
      description: "Everything this session did on the box: each command, its gate verdict (auto/confirm/blocked), its output, errors. Show it to the human at the end, or read it when something failed.",
      inputSchema: { format: z.enum(["text", "json"]).default("text") },
      handler: async (a) => {
        if (!session) return ok({ report: null });
        return a.format === "json" ? ok(session.report.toJSON()) : { content: [{ type: "text", text: session.report.toText() }] };
      }
    }),
    shell: tool({
      title: "Raw shell (gated)",
      destructive: true,
      description: `Run one "adb shell" command on the box through the command gate. AUTO commands run at once: getprop, dumpsys, pm list/path/dump, settings get/list, am start (no extras), input keyevent, cmd package resolve-activity/list, df, screencap, ls, echo, whoami, id, uptime, wm size/density, ip addr/route, netstat. ANYTHING ELSE needs a human: the first call returns {needsConfirmation:true, command, reason} and does NOT run \u2014 show the exact command to the human, get their explicit yes, then call again with confirmed:true. BLOCKED, no exception even with confirmed:true: reboot bootloader/recovery, fastboot, rm -rf, dd, wipe, su, dpm remove-active-admin / clear-*, factory reset, "settings put global adb_enabled 0" (only handover may), development_settings_enabled 0, pm uninstall/disable of system packages. Do not try to work around the gate (no chaining, no am broadcast MASTER_CLEAR). Prefer the task tools; use shell for diagnosis.`,
      inputSchema: { command: z.string().min(1), confirmed: z.boolean().default(false).describe("true ONLY after a human explicitly approved this exact command") },
      handler: async (a) => {
        try {
          const g = classifyCommand(a.command);
          if (g.verdict === "blocked") {
            if (session) await session.engine.exec(a.command);
            return fail({ ran: false, blocked: true, command: a.command, reason: g.reason });
          }
          if (g.verdict === "confirm" && !a.confirmed) return ok({ ran: false, needsConfirmation: true, command: a.command, reason: g.reason, how: "show this command to the human; if they approve, call shell again with confirmed:true" });
          await reconnectIfRebooted();
          const s = need();
          allowConfirm = g.verdict === "confirm" && a.confirmed;
          try {
            const r = await s.engine.exec(a.command);
            return ok({ ran: r.ran, verdict: r.verdict, output: r.output });
          } finally {
            allowConfirm = false;
          }
        } catch (e) {
          return fail(errInfo(e));
        }
      }
    })
  };
  return tools;
}
function createMcpServer(ctx) {
  const withShell = ctx.shell !== false;
  const server = new McpServer(
    { name: `${ctx.brand.cli}-${ctx.brand.id}`, version: ctx.version },
    {
      instructions: `${ctx.brand.name}: provisions Android TV boxes over ADB for ${ctx.brand.launcherName}. Typical run: discover \u2192 connect (the human presses Allow on the TV) \u2192 check \u2192 provision (stopBefore "test" to keep the session) \u2192 screenshot \u2192 test \u2192 connect again \u2192 check \u2192 report. Ask the human only for what must happen on the TV (Allow, HOME, picking the launcher, removing a Google account). Never paste adb commands for the human to run; use the tools.${withShell ? " shell is gated: confirm-level commands need the human's explicit approval, blocked ones never run." : " There is no raw shell in this build: only the named tools reach the box."}`
    }
  );
  const tools = createTools(ctx);
  for (const [name, t] of Object.entries(tools)) {
    if (name === "shell" && !withShell) continue;
    if (name === "link" && ctx.brand.flow !== "kiosk") continue;
    server.registerTool(name, { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: t.readOnly === true, destructiveHint: t.destructive === true, openWorldHint: t.local !== true } }, (args) => t.handler(args));
  }
  return { server, tools };
}
async function runMcp(ctx) {
  const { server } = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.once("end", () => resolve());
  });
}

// apps/cli/src/main.ts
function table(rows) {
  const w = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `${k.padEnd(w)}  ${Array.isArray(v) ? v.length ? v.join(", ") : "\u2014" : v === null || v === void 0 || v === "" ? "\u2014" : String(v)}`).join("\n");
}
function checkRows(c) {
  return [
    ["model", `${c.manufacturer} ${c.model}`.trim()],
    ["platform", c.platform + (c.isTv ? "" : " (not a TV build)")],
    ["android", `${c.androidVersion} (API ${c.sdk})`],
    ["serial", c.serial],
    ["accounts", c.accounts],
    ["free", c.freeBytes === null ? null : `${(c.freeBytes / 1024 ** 3).toFixed(1)} GB of ${c.totalBytes === null ? "?" : (c.totalBytes / 1024 ** 3).toFixed(1)} GB`],
    ["launcher", c.launcherInstalled ? `installed (${c.launcherVersionCode ?? "?"})` : "not installed"],
    ["home", c.currentHome],
    ["stock launcher", c.stockLauncher],
    ["device owner", c.deviceOwner],
    ["developer options", c.developerOptions ? "on" : "off"],
    ["adb", c.adbEnabled ? "on" : "off"],
    ["packages", c.installedPackages.length]
  ];
}
async function withSession(o, io, fn) {
  const brand = targetConfig(o.target);
  const transport = createTransport(o);
  const device = await pickDevice(transport, o, io);
  const session = createSession({ brand, device, io, autoConfirm: o.yes, mock: Boolean(o.mock), verbose: !o.json || o.mock === void 0 });
  session.transport = transport;
  try {
    const check = await session.engine.check();
    session.report.meta.device = { serial: check.serial || device.serial, model: `${check.manufacturer} ${check.model}`.trim() || device.info.name, addr: device.info.addr };
    return await fn(session, check);
  } finally {
    if (!o.mock) await saveReport(session.report).then((p) => io.err(`report: ${p}.txt`)).catch(() => {
    });
    await session.device.close().catch(() => {
    });
  }
}
async function provision(o, io, s, check, manifest) {
  const ctx = stepContext(o, s.brand, check);
  const result = { profile: null, install: null, launcher: null, configure: null, test: null, handover: null, maintenance: null };
  for (const task of autoRunOrder(s.brand)) {
    if (o.stopBefore === task) break;
    if (s.rebooted && s.transport && !await reconnectAfterReboot(s, s.transport, io)) {
      io.err(`the box did not come back after the reboot \u2014 ${task} skipped`);
      break;
    }
    if (task === "install") {
      result.install = manifest ? await s.engine.install(manifest, o.role, { installed: new Map(check.installedPackages.map((p) => [p, null])) }) : false;
      if (!result.install) break;
      continue;
    }
    result[task] = await s.engine.runTask(task, ctx, task === "launcher" ? o.method : void 0);
    if (!result[task] && task !== "configure" && task !== "test") break;
  }
  return result;
}
async function runCli(argv, ioIn = {}) {
  const io = { ...defaultIo(), ...ioIn };
  let o;
  try {
    o = parseCli(argv);
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e));
    io.err(USAGE);
    return 2;
  }
  const emit = (json, human) => io.out(o.json ? JSON.stringify(json) : human);
  const brand = targetConfig(o.target);
  try {
    switch (o.command) {
      case "help":
        io.out(USAGE);
        return 0;
      case "version":
        emit({ tool: brand.cli, version: TOOL_VERSION, brand: brand.id }, `${brand.cli} ${TOOL_VERSION} (${brand.name})`);
        return 0;
      case "discover": {
        const transport = createTransport(o);
        const found = [];
        try {
          const list = await transport.discover({ paths: o.usb ? ["usb"] : void 0, subnet: o.subnet, onFound: (d) => !o.json && io.err(`found ${d.addr}  ${d.name}`) });
          found.push(...list);
        } catch (e) {
          if (!(e instanceof NoDevicesError)) throw e;
          if (!o.json) io.err(`no devices (${e.hint})`);
        }
        io.out(o.json ? JSON.stringify(found) : found.length ? table(found.map((d) => [d.addr, `${d.name}  [${d.method}${d.tls ? ", tls" : ""}]`])) : "no devices");
        return 0;
      }
      case "pair": {
        const [hostPort, code] = o.positionals;
        if (!hostPort || !code) throw new UsageError("pair needs host:port and the 6-digit code");
        const transport = createTransport(o);
        if (!transport.pair) throw new Error("this transport cannot pair");
        await transport.pair(hostPort, code);
        emit({ paired: hostPort }, `paired ${hostPort} \u2014 now: tvlm check --connect ${hostPort}`);
        return 0;
      }
      case "check":
        return await withSession(o, io, async (s, check) => {
          emit({ ...check, brand: brand.id, tool: TOOL_VERSION }, table(checkRows(check)));
          return 0;
        });
      case "provision":
        return await withSession(o, io, async (s, check) => {
          let manifest = null;
          try {
            manifest = await loadManifest(o, brand);
          } catch (e) {
            io.err(`manifest: ${e instanceof Error ? e.message : String(e)}`);
          }
          const result = await provision(o, io, s, check, manifest);
          const ran = Object.entries(result).filter(([, v]) => v !== null);
          const ok2 = ran.every(([, v]) => v === true);
          emit({ ok: ok2, tasks: result, humanActions: s.humanActions, profile: stepContext(o, brand, check).profile }, table(ran.map(([k, v]) => [k, v ? "ok" : "FAILED"])) + (ok2 ? "\nprovisioned" : "\nprovisioning stopped \u2014 see the report"));
          return ok2 ? 0 : 1;
        });
      case "install":
        return await withSession(o, io, async (s, check) => {
          const manifest = await loadManifest(o, brand);
          const ok2 = await s.engine.install(manifest, o.role, { installed: new Map(check.installedPackages.map((p) => [p, null])) });
          emit({ ok: ok2, apps: manifest.apps.map((a) => a.pkg) }, ok2 ? "installed" : "install failed \u2014 see the report");
          return ok2 ? 0 : 1;
        });
      case "launcher":
      case "configure":
      case "test":
      case "handover":
        return await withSession(o, io, async (s, check) => {
          const task = o.command;
          const ok2 = await s.engine.runTask(task, stepContext(o, brand, check), task === "launcher" ? o.method : void 0);
          emit({ ok: ok2, task, humanActions: s.humanActions }, `${task}: ${ok2 ? "ok" : "FAILED"}`);
          return ok2 ? 0 : 1;
        });
      case "link":
        return await withSession(o, io, async (s, check) => {
          const code = o.positionals[0] ?? o.link;
          if (!code) throw new UsageError("link needs the code");
          const ctx = { ...stepContext(o, brand, check), linkCode: code };
          const step = stepsFor({ task: "profile" }, ctx).find((x) => x.id === "profile.link");
          if (!step) throw new Error("this target has no link step");
          const r = await s.engine.exec(renderCommand(step, ctx), { stepId: step.id });
          const ok2 = r.ran && /Broadcast completed/i.test(r.output);
          emit({ ok: ok2, code }, ok2 ? "linked" : "link failed");
          return ok2 ? 0 : 1;
        });
      case "screenshot":
        return await withSession(o, io, async (s) => {
          const png = await s.device.screencap();
          const out = o.out ?? `tvlm-screenshot-${Date.now()}.png`;
          if (o.json && !o.out) emit({ png: Buffer.from(png).toString("base64"), bytes: png.byteLength }, "");
          else {
            await writeFile3(out, png);
            emit({ file: out, bytes: png.byteLength }, `${out} (${png.byteLength} bytes)`);
          }
          return 0;
        });
      case "report": {
        const r = await latestReport();
        if (!r) {
          emit({ report: null }, "no report yet");
          return 1;
        }
        if (o.out) await writeFile3(o.out, o.json ? r.json : r.text);
        io.out(o.out ? o.json ? JSON.stringify({ file: o.out }) : `written ${o.out}` : o.json ? r.json : r.text);
        return 0;
      }
      case "bridge": {
        const transport = createTransport(o);
        const srv = await runBridge({ port: o.port, transport, brand: brand.id, version: TOOL_VERSION, log: (m) => io.err(m) });
        io.err(`bridge listening on ws://127.0.0.1:${srv.port} \u2014 leave this window open; Ctrl+C stops it`);
        await new Promise((resolve) => {
          process.once("SIGINT", () => resolve());
          process.once("SIGTERM", () => resolve());
        });
        await srv.close();
        return 0;
      }
      case "mcp":
        await runMcp({ transport: createTransport(o), brand, version: TOOL_VERSION, mock: Boolean(o.mock), shell: o.shell, log: (m) => io.err(m) });
        return 0;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      return 2;
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (o.json) io.out(JSON.stringify({ error: msg, kind: e instanceof UnauthorizedError ? "unauthorized" : e instanceof NoDevicesError ? `no-devices:${e.hint}` : "error" }));
    else io.err(`error: ${msg}`);
    return 1;
  }
  return 0;
}
var entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) process.exitCode = await runCli(process.argv.slice(2));

// apps/cli/tvboxtools-entry.ts
process.exitCode = await runCli(process.argv.slice(2));
