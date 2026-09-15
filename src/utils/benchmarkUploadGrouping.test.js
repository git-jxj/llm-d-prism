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

import { describe, expect, it } from 'vitest';
import { groupStandaloneBRV02Stages } from './benchmarkUploadGrouping.js';
import { groupStagesIntoRuns } from './benchmarkReportV02Parser.js';

const stage = (filename, runUid, loadMetadata) => ({
    file: { name: filename },
    content: `report-${filename}`,
    validation: { format: 'brv02' },
    parsedStage: {
        runUid,
        loadMetadata,
        runLabel: filename,
    },
});

describe('standalone BRV02 upload grouping', () => {
    it('keeps path-less reports with the same run.uid in separate groups', () => {
        let id = 0;
        const groups = groupStandaloneBRV02Stages([
            stage('stage-a.yaml', 'shared-uid', { concurrency: 8 }),
            stage('stage-b.yaml', 'shared-uid', { concurrency: 16 }),
        ], () => `id-${id++}`);

        expect(groups).toHaveLength(2);
        expect(groups.map(group => group.files.map(file => file.name))).toEqual([
            ['stage-a.yaml'],
            ['stage-b.yaml'],
        ]);
        expect(groups.map(group => group.dirKey)).toEqual(['staged-id-0', 'staged-id-1']);
    });

    it('keeps path-less reports separate even when load metadata matches', () => {
        let id = 0;
        const groups = groupStandaloneBRV02Stages([
            stage('stage-a.yaml', 'uid-a', { concurrency: 8 }),
            stage('stage-b.yaml', 'uid-b', { concurrency: 8 }),
        ], () => `id-${id++}`);

        expect(groups).toHaveLength(2);
    });

    it('preserves metadata-based coalescing for directory-backed stages', () => {
        const runs = groupStagesIntoRuns([
            { filename: 'run/stage-a.yaml', loadMetadata: { concurrency: 8 } },
            { filename: 'run/stage-b.yaml', loadMetadata: { concurrency: 8 } },
        ]);

        expect(runs).toHaveLength(1);
        expect(runs[0].stages).toHaveLength(2);
    });
});
