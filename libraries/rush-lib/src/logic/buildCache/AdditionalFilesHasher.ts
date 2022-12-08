// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.
import { Async, FileSystem, Import, LegacyAdapters } from '@rushstack/node-core-library';
import crypto from 'crypto';
import path from 'path';

import type { IOptions } from 'glob';

const glob: typeof import('glob') = Import.lazy('glob', require);

const globAsync = (pattern: string, options: IOptions = {}): Promise<string[]> => {
  return LegacyAdapters.convertCallbackToPromise(glob, pattern, options);
};

export class AdditionalFilesHasher {
  public static async getFileHashedFilesMap(
    globPatterns: string[],
    cwd: string
  ): Promise<Map<string, string>> {
    const filePaths: Set<string> = await this._expandGlobPatterns(globPatterns, cwd);

    return await this._calculateFileHashes(filePaths, cwd);
  }

  private static async _expandGlobPatterns(globPatterns: string[], cwd: string): Promise<Set<string>> {
    const allMatches: Set<string> = new Set<string>();

    await Async.forEachAsync(
      globPatterns,
      async (pattern) => {
        const matches: string[] = await globAsync(pattern, {
          cwd,
          nodir: true,
          // We want to keep path's type unchanged,
          // i.e. if the pattern was a  relative path, then matched paths should also be relative paths
          //      if the pattern was an absolute path, then matched paths should also be absolute paths
          //
          // We are doing this because these paths are going to be used to calculate a hash for the build cache and some users
          // might choose to depend on global files (e.g. `/etc/os-release`) and some might choose to depend on local files
          // (e.g. `../path/to/workspace/file`)
          //
          // In both cases we want that path to the resource would be the same on all machines,
          // regardless of what is the current working directory.
          //
          // That being said, we want to keep `realpath` and `absolute` options here as false:
          realpath: false,
          absolute: false
        });
        matches.forEach((match) => allMatches.add(match));
      },
      { concurrency: 10 }
    );

    if (allMatches.size === 0) {
      throw new Error(
        `Couldn't find any files matching provided glob patterns: ["${globPatterns.join('", "')}"].`
      );
    }

    return allMatches;
  }

  private static async _calculateFileHashes(
    filePaths: Set<string>,
    cwd: string
  ): Promise<Map<string, string>> {
    const fileHashes: Map<string, string> = new Map<string, string>();

    await Async.forEachAsync(
      filePaths,
      async (filepath) => {
        const fullPath: string = path.isAbsolute(filepath) ? filepath : path.join(cwd, filepath);
        const content: string = await FileSystem.readFileAsync(fullPath);

        const hashValue: string = crypto.createHash('sha1').update(content).digest('hex');

        fileHashes.set(filepath, hashValue);
      },
      { concurrency: 10 }
    );

    return fileHashes;
  }
}
