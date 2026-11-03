import * as os from "os";
import * as path from "path";

import * as asar from "asar";
import * as diff from "diff";
import * as fs from "fs-extra";
import natsort from "natsort";

import {baseDir} from "../global";
import {CURRENT_PLATFORM, Platforms} from "./platform";
import {PatcherV12} from "./v12";

/**
 * Patcher options
 */
export interface IPatcherOptions {
  /**
   * app.asar file
   */
  readonly asar?: string;

  /**
   * app directory
   */
  readonly dir?: string;

  /**
   * Patcher features
   */
  readonly features: string[];
}

/**
 * Patch result
 */
export interface IPatchResult {
  /**
   * Patch mode (`v12` for GitKraken 10+, `legacy` for older versions)
   */
  readonly mode: "v12" | "legacy";

  /**
   * Number of patched selectors / files
   */
  readonly patched: number;

  /**
   * `true` when GitKraken is already patched
   */
  readonly alreadyPatched: boolean;

  /**
   * Number of mirrored files in the extracted app directory
   */
  readonly mirrored: number;
}

/**
 * Patcher
 */
export class Patcher {
  private static findAsarUnix(...files: string[]): string | undefined {
    return files.find((file) => fs.existsSync(file));
  }

  private static findAsarLinux(): string | undefined {
    return Patcher.findAsarUnix(
      "/opt/gitkraken/resources/app.asar", // Arch Linux
      "/usr/share/gitkraken/resources/app.asar", // deb & rpm
    );
  }

  private static findAsarWindows(): string | undefined {
    const gitkrakenLocal = path.join(os.homedir(), "AppData/Local/gitkraken");
    if (!fs.existsSync(gitkrakenLocal)) {
      return undefined;
    }
    const apps = fs
      .readdirSync(gitkrakenLocal)
      .filter((item) => item.match(/^app-\d+\.\d+\.\d+$/));
    let app = apps.sort(natsort({desc: true}))[0];
    if (!app) {
      return undefined;
    }
    app = path.join(gitkrakenLocal, app, "resources/app.asar");
    return fs.existsSync(app) ? app : undefined;
  }

  private static findAsarMacOS(): string | undefined {
    return Patcher.findAsarUnix(
      "/Applications/GitKraken.app/Contents/Resources/app.asar",
    );
  }

  private static findAsar(dir?: string): string | undefined {
    if (dir) {
      return path.normalize(dir) + ".asar";
    }
    switch (CURRENT_PLATFORM) {
      case Platforms.linux:
        return Patcher.findAsarLinux();
      case Platforms.windows:
        return Patcher.findAsarWindows();
      case Platforms.macOS:
        return Patcher.findAsarMacOS();
    }
  }

  private static findDir(asarFile: string): string {
    return path.join(
      path.dirname(asarFile),
      path.basename(asarFile, path.extname(asarFile)),
    );
  }

  private readonly _asar: string;
  private readonly _dir: string;
  private readonly _features: string[];

  /**
   * Patcher constructor
   * @param options Options
   */
  public constructor(options: IPatcherOptions) {
    const maybeAsar = options.asar || Patcher.findAsar(options.dir);
    if (!maybeAsar) {
      throw new Error("Can't find app.asar!");
    }
    this._asar = maybeAsar;
    this._dir = options.dir || Patcher.findDir(this.asar);
    this._features = options.features;
  }

  /**
   * app.asar file
   */
  public get asar(): string {
    return this._asar;
  }

  /**
   * app directory
   */
  public get dir(): string {
    return this._dir;
  }

  /**
   * Patcher features
   */
  public get features(): string[] {
    return this._features;
  }

  /**
   * GitKraken version (`12.5.0`) or `undefined` when it can't be detected
   */
  public get gitKrakenVersion(): string | undefined {
    const match =
      /app-(\d+\.\d+\.\d+)/.exec(this.asar) ||
      /app-(\d+\.\d+\.\d+)/.exec(this.dir);
    if (match) {
      return match[1];
    }
    try {
      const json = JSON.parse(
        asar.extractFile(this.asar, "package.json").toString("utf8"),
      );
      if (typeof json.version === "string") {
        return json.version;
      }
    } catch {
      // fall through to the extracted directory
    }
    try {
      const json = fs.readJSONSync(path.join(this.dir, "package.json"));
      return typeof json.version === "string" ? json.version : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * `true` when the `v12` feature is selected
   */
  public get isV12Mode(): boolean {
    return this.features.some((feature) => PatcherV12.isV12Feature(feature));
  }

  /**
   * Suggest the feature for the installed GitKraken
   *
   * `v12` for GitKraken 10+, the legacy `pro` patch otherwise. When the version
   * can't be detected (e.g. a custom `--asar` path) the archive is probed for
   * the v12 license selector.
   */
  public suggestFeature(): string {
    const version = this.gitKrakenVersion;
    const major = version ? parseInt(version.split(".")[0], 10) : 0;
    if (major >= 12) {
      return "v12";
    }
    if (major > 0) {
      return "pro";
    }
    try {
      const probe = new PatcherV12(this.asar, this.dir).scan();
      if (probe.hits.length || probe.patchedMarkers) {
        return "v12";
      }
    } catch {
      // fall through to the legacy default
    }
    return "pro";
  }

  /**
   * Backup app.asar once (`app.asar.bak-before-gitcracken`)
   * @returns Backup file
   * @throws Error
   */
  public backupAsarOnce(): string {
    const backup = `${this.asar}.bak-before-gitcracken`;
    if (!fs.existsSync(backup)) {
      fs.copySync(this.asar, backup);
    }
    return backup;
  }

  /**
   * Restore app.asar from `app.asar.bak-before-gitcracken`
   * @returns Backup file
   * @throws Error
   */
  public revertAsar(): string {
    const backup = `${this.asar}.bak-before-gitcracken`;
    if (!fs.existsSync(backup)) {
      throw new Error(`Backup not found: ${backup}`);
    }
    fs.copySync(backup, this.asar);
    return backup;
  }

  /**
   * Patch GitKraken (auto-selects the v12 or the legacy strategy)
   * @throws Error
   */
  public patch(): IPatchResult {
    if (!this.features.length) {
      throw new Error("Features is empty!");
    }
    if (this.isV12Mode) {
      const patcher = new PatcherV12(this.asar, this.dir);
      const result = patcher.patch();
      return {
        mode: "v12",
        patched: result.patched,
        alreadyPatched: result.alreadyPatched,
        mirrored: patcher.patchExtractedDir(),
      };
    }
    this.patchDir();
    return {
      mode: "legacy",
      patched: this.features.length,
      alreadyPatched: false,
      mirrored: 0,
    };
  }

  /**
   * Backup app.asar file
   * @throws Error
   */
  public backupAsar(): string {
    const backup = `${this.asar}.${new Date().getTime()}.backup`;
    fs.copySync(this.asar, backup);
    return backup;
  }

  /**
   * Unpack app.asar file into app directory
   * @throws Error
   */
  public unpackAsar(): void {
    asar.extractAll(this.asar, this.dir);
  }

  /**
   * Pack app directory to app.asar file
   * @throws Error
   */
  public packDirAsync(): Promise<void> {
    return asar.createPackage(this.dir, this.asar);
  }

  /**
   * Remove app directory
   * @throws Error
   */
  public removeDir(): void {
    fs.removeSync(this.dir);
  }

  /**
   * Patch app directory
   * @throws Error
   */
  public patchDir(): void {
    if (!this.features.length) {
      throw new Error("Features is empty!");
    }
    for (const feature of this.features) {
      switch (feature) {
        case "pro":
          this.patchDirWithPro();
          break;

        default:
          this.patchDirWithFeature(feature);
          break;
      }
    }
  }

  private patchDirWithPro(): void {
    const bundlePath = path.join(this.dir, "src/main/static/main.bundle.js");

    const patchedPattern = '(delete json.proAccessState,delete json.licenseExpiresAt,json={...json,licensedFeatures:["pro"]});';

    const pattern1 = /const [^=]*="dev"===[^?]*\?"[\w+/=]+":"[\w+/=]+";/;
    const pattern2 = /return (JSON\.parse\(\([^;]*?\)\(Buffer\.from\([^;]*?,"base64"\)\.toString\("utf8"\),Buffer\.from\([^;]*?\.secure,"base64"\)\)\.toString\("utf8"\)\))\};/;
    const searchValue = new RegExp(`(?<=${pattern1.source})${pattern2.source}`)
    const replaceValue =
      "var json=$1;" +
      '("licenseExpiresAt"in json||"licensedFeatures"in json)&&' +
      '(delete json.proAccessState,delete json.licenseExpiresAt,json={...json,licensedFeatures:["pro"]});' +
      "return json};";

    const sourceData = fs.readFileSync(bundlePath, "utf-8");
    const sourcePatchedData = sourceData.replace(searchValue, replaceValue);
    if (sourceData === sourcePatchedData) {
      if (sourceData.indexOf(patchedPattern) < 0) throw new Error("Can't patch pro features, pattern match failed. Get support from https://t.me/gitkrakencrackchat");
      throw new Error("It's already patched.");
    }
    fs.writeFileSync(bundlePath, sourcePatchedData, "utf-8");
  }

  private patchDirWithFeature(feature: string): void {
    const patches = diff.parsePatch(
      fs.readFileSync(path.join(baseDir, "patches", `${feature}.diff`), "utf8"),
    );
    for (const patch of patches) {
      this.patchDirWithPatch(patch);
    }
  }

  private patchDirWithPatch(patch: diff.ParsedDiff): void {
    const sourceData = fs.readFileSync(
      path.join(this.dir, patch.oldFileName!),
      "utf8",
    );
    const sourcePatchedData = diff.applyPatch(sourceData, patch);
    if ((sourcePatchedData as any) === false) {
      throw new Error(`Can't patch ${patch.oldFileName}`);
    }
    if (patch.oldFileName !== patch.newFileName) {
      fs.unlinkSync(path.join(this.dir, patch.oldFileName!));
    }
    fs.writeFileSync(
      path.join(this.dir, patch.newFileName!),
      sourcePatchedData,
      "utf8",
    );
  }
}
