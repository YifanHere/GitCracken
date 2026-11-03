import * as fs from "fs-extra";
import * as path from "path";

/**
 * GitKraken v12+ license selector patch.
 *
 * Since GitKraken 10 the paid tier is no longer derived from the decoded
 * phone-home body (`decodeBody`, the old `pro` patch). Every paid gate is
 * computed by the redux selector `getLicensedFeatures`, which reads
 * `appSettings.licensedFeatures`, and the only values that unlock the paid
 * tiers are `advanced`, `teamsLicense` and `enterprise`.
 *
 * The selector is shipped in three webpack bundles inside `app.asar`.  This
 * patcher rewrites its result function to `() => ["advanced"]` **in place**:
 * the replacement has exactly the same byte length, the ASAR header keeps its
 * file offsets/sizes, and no `asar pack` (which would duplicate every
 * `app.asar.unpacked` file and double the install size) is required.
 */

/**
 * Feature names handled by this patcher
 */
export const V12_FEATURES = ["v12", "advanced"];

const SELECTOR_PREFIX = "getLicensedFeatures=(0,";
const SELECTOR_PATTERN = /getLicensedFeatures=\(0,[\w$]+\.createSelector\)\(getAppSettings,\(\(\{licensedFeatures:([\w$]+)\}\)=>\1\)\)/;
const INNER_PATTERN = /\(\(\{licensedFeatures:([\w$]+)\}\)=>\1\)/;
const PATCHED_MARK = '(()=>["advanced"]';

const CHUNK_SIZE = 16 * 1024 * 1024;
const OVERLAP = 4 * 1024;
const WINDOW = 320;

/**
 * One selector occurrence inside app.asar
 */
export interface IV12Hit {
  /**
   * Byte offset inside app.asar
   */
  readonly offset: number;

  /**
   * Matched selector source
   */
  readonly selector: string;
}

/**
 * Result of an app.asar scan
 */
export interface IV12ScanResult {
  /**
   * Selectors that still need to be patched
   */
  readonly hits: IV12Hit[];

  /**
   * Number of already patched selector markers
   */
  readonly patchedMarkers: number;
}

/**
 * Result of a patch run
 */
export interface IV12PatchResult {
  /**
   * Number of patched selectors
   */
  readonly patched: number;

  /**
   * `true` when the archive was already patched
   */
  readonly alreadyPatched: boolean;
}

/**
 * GitKraken v12+ patcher
 */
export class PatcherV12 {
  /**
   * Bundles that contain the license selector
   */
  public static readonly bundles = [
    "src/main/static/main.bundle.js",
    "src/render/static/entryPoints/main/render.bundle.js",
    "src/render/static/entryPoints/requestHandler/requestHandler.bundle.js",
  ];

  /**
   * Check whether a feature name belongs to this patcher
   * @param feature Feature name
   */
  public static isV12Feature(feature: string): boolean {
    return V12_FEATURES.indexOf(feature.toLowerCase()) >= 0;
  }

  /**
   * Build the same-length replacement for an inner selector
   * @param inner Inner selector, e.g. `(({licensedFeatures:re})=>re)`
   * @throws Error
   */
  public static makeReplacement(inner: string): string {
    const pad = inner.length - PATCHED_MARK.length - 1;
    if (pad < 0) {
      throw new Error(`Selector is too short to patch: ${inner}`);
    }
    return PATCHED_MARK + " ".repeat(pad) + ")";
  }

  private readonly _asar: string;
  private readonly _dir?: string;

  /**
   * Patcher constructor
   * @param asar app.asar file
   * @param dir Optional extracted app directory (mirrored for consistency)
   */
  public constructor(asar: string, dir?: string) {
    this._asar = asar;
    this._dir = dir;
  }

  /**
   * app.asar file
   */
  public get asar(): string {
    return this._asar;
  }

  /**
   * Extracted app directory
   */
  public get dir(): string | undefined {
    return this._dir;
  }

  /**
   * Scan app.asar for selector occurrences
   * @throws Error
   */
  public scan(): IV12ScanResult {
    if (!fs.existsSync(this.asar)) {
      throw new Error(`Can't find ${this.asar}`);
    }

    const size = fs.statSync(this.asar).size;
    const fd = fs.openSync(this.asar, "r");
    const marker = Buffer.from(PATCHED_MARK, "utf8");
    const prefix = Buffer.from(SELECTOR_PREFIX, "utf8");
    const hits = new Map<number, string>();
    let patchedMarkers = 0;

    try {
      let pos = 0;
      let carry = Buffer.alloc(0);
      while (pos < size) {
        const buf = Buffer.allocUnsafe(CHUNK_SIZE);
        const read = fs.readSync(fd, buf, 0, CHUNK_SIZE, pos);
        if (read <= 0) {
          break;
        }

        const data = Buffer.concat([carry, buf.slice(0, read)]);
        const base = pos - carry.length;

        let markerIndex = -1;
        while ((markerIndex = data.indexOf(marker, markerIndex + 1)) !== -1) {
          const absolute = base + markerIndex;
          if (
            absolute >= pos &&
            absolute + marker.length <= pos + read
          ) {
            patchedMarkers++;
          }
        }

        let index = -1;
        while ((index = data.indexOf(prefix, index + 1)) !== -1) {
          const absolute = base + index;
          if (hits.has(absolute)) {
            continue;
          }
          const window = data
            .slice(index, Math.min(data.length, index + WINDOW))
            .toString("latin1");
          const match = SELECTOR_PATTERN.exec(window);
          if (match) {
            hits.set(absolute, match[0]);
          }
        }

        carry = data.slice(Math.max(0, data.length - OVERLAP));
        pos += read;
      }
    } finally {
      fs.closeSync(fd);
    }

    return {hits: Array.from(hits.keys()).map((offset) => ({
      offset,
      selector: hits.get(offset) as string,
    })), patchedMarkers};
  }

  /**
   * Patch app.asar in place
   * @throws Error
   */
  public patch(): IV12PatchResult {
    const scan = this.scan();
    if (!scan.hits.length) {
      if (scan.patchedMarkers > 0) {
        return {patched: 0, alreadyPatched: true};
      }
      throw new Error(
        "Can't patch GitKraken v12 license selector, pattern match failed. " +
          "This GitKraken build probably changed the selector.",
      );
    }

    const fd = fs.openSync(this.asar, "r+");
    try {
      for (const hit of scan.hits) {
        const inner = INNER_PATTERN.exec(hit.selector);
        if (!inner) {
          throw new Error(`Can't parse selector: ${hit.selector}`);
        }
        const patched = hit.selector.replace(
          inner[0],
          PatcherV12.makeReplacement(inner[0]),
        );
        const buf = Buffer.from(patched, "utf8");
        if (buf.length !== Buffer.byteLength(hit.selector, "utf8")) {
          throw new Error("Internal error: replacement length mismatch");
        }
        fs.writeSync(fd, buf, 0, buf.length, hit.offset);
      }
    } finally {
      fs.closeSync(fd);
    }

    const verify = this.scan();
    if (verify.hits.length) {
      throw new Error(
        `Verification failed: ${verify.hits.length} selector(s) left unpatched`,
      );
    }

    return {patched: scan.hits.length, alreadyPatched: false};
  }

  /**
   * Mirror the patch into an extracted app directory (when present)
   * @returns Number of patched files
   */
  public patchExtractedDir(): number {
    if (!this.dir || !fs.existsSync(this.dir)) {
      return 0;
    }

    let patchedFiles = 0;
    for (const bundle of PatcherV12.bundles) {
      const file = path.join(this.dir, bundle);
      if (!fs.existsSync(file)) {
        continue;
      }

      const source = fs.readFileSync(file, "utf8");
      let count = 0;
      const output = source.replace(
        new RegExp(SELECTOR_PATTERN.source, "g"),
        (whole: string) => {
          const inner = INNER_PATTERN.exec(whole);
          if (!inner) {
            return whole;
          }
          count++;
          return whole.replace(inner[0], PatcherV12.makeReplacement(inner[0]));
        },
      );

      if (count) {
        fs.writeFileSync(file, output, "utf8");
        patchedFiles++;
      }
    }

    return patchedFiles;
  }
}
