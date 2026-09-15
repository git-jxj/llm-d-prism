// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { v4 as uuidv4 } from 'uuid';

/**
 * Group standalone BRV02 report files for the upload staging flow.
 *
 * Standalone files have no directory identity. Keep every file in its own
 * group; report uids and load metadata are not reliable identities for
 * independently uploaded files.
 */
export function groupStandaloneBRV02Stages(stages, makeId = uuidv4) {
    return stages.map(item => {
        const parsedStage = item.parsedStage;
        const tempId = makeId();
        const stage = {
            file: item.file,
            content: item.content,
            validation: item.validation,
        };

        return {
            id: tempId,
            // Keep the staging identity independent of report metadata. Two
            // path-less files may legitimately carry the same run uid (and
            // even the same filename when selected from different folders).
            dirKey: `staged-${tempId}`,
            name: parsedStage?.runLabel || '',
            runUid: parsedStage?.runUid,
            loadMetadata: parsedStage?.loadMetadata,
            files: [item.file],
            parsedStages: [stage],
        };
    });
}
