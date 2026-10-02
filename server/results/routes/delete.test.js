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

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../oauth.ts', () => ({
    validateGitHubToken: vi.fn()
}));

vi.mock('../../iam.ts', () => ({
    isPlaygroundMode: vi.fn(() => false)
}));

vi.mock('../gcs.ts', () => ({
    readResultMetadata: vi.fn(),
    readResultPayload: vi.fn(),
    writeResult: vi.fn(),
    deleteResult: vi.fn()
}));

vi.mock('../processing.ts', () => ({
    processSubmission: vi.fn()
}));

import { validateGitHubToken } from '../../oauth.ts';
import { isPlaygroundMode } from '../../iam.ts';
import { readResultMetadata, readResultPayload, writeResult, deleteResult } from '../gcs.ts';
import { processSubmission } from '../processing.ts';
import { deleteResultsHandler } from './delete.ts';
import { promoteResultsHandler } from './promote.ts';
import { reviewResultsHandler } from './review.ts';

const VALID_RUN_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

function createMockReqRes({
    runId = VALID_RUN_ID,
    token,
    body = {}
} = {}) {
    const headers = {};
    if (token !== undefined) {
        headers['x-prism-github-token'] = token;
    }

    const req = {
        params: { runId },
        headers,
        body
    };

    const res = {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        }
    };

    return { req, res };
}

describe('Results Store deletion & lifecycle role access', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(isPlaygroundMode).mockReturnValue(false);
    });

    describe('DELETE /api/results/:runId — validation & authentication', () => {
        it('rejects non-UUID runId formats (400 Bad Request) before auth or GCS calls', async () => {
            for (const invalidId of ['not-a-uuid', '../prism-iam/github-admin-allowlist.txt', '12345']) {
                const { req, res } = createMockReqRes({ runId: invalidId, token: 'valid-token' });
                await deleteResultsHandler(req, res);

                expect(res.statusCode).toBe(400);
                expect(res.body.error).toMatch(/Invalid runId format/i);
                expect(validateGitHubToken).not.toHaveBeenCalled();
                expect(readResultMetadata).not.toHaveBeenCalled();
            }
        });

        it('rejects unauthenticated requests when no token is provided (401 Unauthorized)', async () => {
            const { req, res } = createMockReqRes({ token: undefined });
            await deleteResultsHandler(req, res);

            expect(res.statusCode).toBe(401);
            expect(res.body.error).toMatch(/Authentication required/i);
            expect(readResultMetadata).not.toHaveBeenCalled();
        });

        it('rejects requests with an invalid or expired token (401 Unauthorized)', async () => {
            vi.mocked(validateGitHubToken).mockRejectedValueOnce(new Error('Bad credentials'));

            const { req, res } = createMockReqRes({ token: 'expired-token' });
            await deleteResultsHandler(req, res);

            expect(res.statusCode).toBe(401);
            expect(res.body.error).toMatch(/Invalid or expired session token/i);
            expect(readResultMetadata).not.toHaveBeenCalled();
        });

        it('returns 404 Not Found when the benchmark does not exist in GCS', async () => {
            vi.mocked(validateGitHubToken).mockResolvedValueOnce({ username: 'alice', permission: 'user' });
            vi.mocked(readResultMetadata).mockResolvedValueOnce(null);

            const { req, res } = createMockReqRes({ token: 'alice-token' });
            await deleteResultsHandler(req, res);

            expect(res.statusCode).toBe(404);
            expect(res.body.error).toMatch(/not found/i);
            expect(deleteResult).not.toHaveBeenCalled();
            expect(writeResult).not.toHaveBeenCalled();
        });
    });

    describe('DELETE /api/results/:runId — non-owner & guest access denied (403 Forbidden)', () => {
        const allStates = [
            'unlisted',
            'rejected',
            'submitted_pending_review',
            'submitted_pending_processing',
            'public',
            'promoted'
        ];

        it.each(allStates)(
            'forbids a non-owner contributor (permission: user) from deleting or withdrawing another user\'s %s benchmark',
            async (state) => {
                vi.mocked(validateGitHubToken).mockResolvedValueOnce({ username: 'bob', permission: 'user' });
                vi.mocked(readResultMetadata).mockResolvedValueOnce({ user: 'alice', state });

                const { req, res } = createMockReqRes({ token: 'bob-token' });
                await deleteResultsHandler(req, res);

                expect(res.statusCode).toBe(403);
                expect(res.body.error).toMatch(/Forbidden/i);
                expect(deleteResult).not.toHaveBeenCalled();
                expect(writeResult).not.toHaveBeenCalled();
            }
        );

        it.each(allStates)(
            'forbids a non-allowlisted guest (permission: none) from deleting or withdrawing another user\'s %s benchmark',
            async (state) => {
                vi.mocked(validateGitHubToken).mockResolvedValueOnce({ username: 'stranger', permission: 'none' });
                vi.mocked(readResultMetadata).mockResolvedValueOnce({ user: 'alice', state });

                const { req, res } = createMockReqRes({ token: 'stranger-token' });
                await deleteResultsHandler(req, res);

                expect(res.statusCode).toBe(403);
                expect(deleteResult).not.toHaveBeenCalled();
                expect(writeResult).not.toHaveBeenCalled();
            }
        );
    });

    describe('DELETE /api/results/:runId — submitting owner access (own benchmarks)', () => {
        it('permanently deletes an owner\'s own unlisted benchmark from GCS', async () => {
            vi.mocked(validateGitHubToken).mockResolvedValueOnce({ username: 'alice', permission: 'user' });
            vi.mocked(readResultMetadata).mockResolvedValueOnce({ user: 'alice', state: 'unlisted' });
            vi.mocked(deleteResult).mockResolvedValueOnce(undefined);

            const { req, res } = createMockReqRes({ token: 'alice-token' });
            await deleteResultsHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({
                success: true,
                message: `Benchmark ${VALID_RUN_ID} successfully deleted.`
            });
            expect(deleteResult).toHaveBeenCalledWith(VALID_RUN_ID);
            expect(writeResult).not.toHaveBeenCalled();
        });

        it('permanently deletes an owner\'s own rejected benchmark from GCS', async () => {
            vi.mocked(validateGitHubToken).mockResolvedValueOnce({ username: 'alice', permission: 'user' });
            vi.mocked(readResultMetadata).mockResolvedValueOnce({ user: 'alice', state: 'rejected' });
            vi.mocked(deleteResult).mockResolvedValueOnce(undefined);

            const { req, res } = createMockReqRes({ token: 'alice-token' });
            await deleteResultsHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({
                success: true,
                message: `Benchmark ${VALID_RUN_ID} successfully deleted.`
            });
            expect(deleteResult).toHaveBeenCalledWith(VALID_RUN_ID);
            expect(writeResult).not.toHaveBeenCalled();
        });

        it('matches owner username case-insensitively', async () => {
            vi.mocked(validateGitHubToken).mockResolvedValueOnce({ username: 'Alice_Dev', permission: 'user' });
            vi.mocked(readResultMetadata).mockResolvedValueOnce({ user: 'alice_dev', state: 'unlisted' });
            vi.mocked(deleteResult).mockResolvedValueOnce(undefined);

            const { req, res } = createMockReqRes({ token: 'alice-token' });
            await deleteResultsHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(deleteResult).toHaveBeenCalledWith(VALID_RUN_ID);
        });

        it('withdraws an owner\'s own submitted_pending_review benchmark back to unlisted', async () => {
            vi.mocked(validateGitHubToken).mockResolvedValueOnce({ username: 'alice', permission: 'user' });
            vi.mocked(readResultMetadata).mockResolvedValueOnce({ user: 'alice', state: 'submitted_pending_review' });
            vi.mocked(readResultPayload).mockResolvedValueOnce({ runId: VALID_RUN_ID, entries: [] });
            vi.mocked(writeResult).mockResolvedValueOnce(undefined);

            const { req, res } = createMockReqRes({ token: 'alice-token' });
            await deleteResultsHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({
                success: true,
                message: `Benchmark ${VALID_RUN_ID} successfully withdrawn to unlisted.`
            });
            expect(deleteResult).not.toHaveBeenCalled();
            expect(writeResult).toHaveBeenCalledTimes(1);

            const [calledRunId, updatedPayload, newState, ownerUser] = vi.mocked(writeResult).mock.calls[0];
            expect(calledRunId).toBe(VALID_RUN_ID);
            expect(newState).toBe('unlisted');
            expect(ownerUser).toBe('alice');
            expect(updatedPayload.review.history).toHaveLength(1);
            expect(updatedPayload.review.history[0]).toMatchObject({
                status: 'unlisted',
                by: 'alice'
            });
        });

        it.each(['public', 'promoted'])(
            'unlists an owner\'s own %s benchmark back to unlisted without deleting from GCS',
            async (publicState) => {
                vi.mocked(validateGitHubToken).mockResolvedValueOnce({ username: 'alice', permission: 'user' });
                vi.mocked(readResultMetadata).mockResolvedValueOnce({ user: 'alice', state: publicState });
                vi.mocked(readResultPayload).mockResolvedValueOnce({
                    runId: VALID_RUN_ID,
                    review: { history: [{ status: publicState, changedAt: '2026-01-01T00:00:00Z', by: 'admin' }] }
                });
                vi.mocked(writeResult).mockResolvedValueOnce(undefined);

                const { req, res } = createMockReqRes({ token: 'alice-token' });
                await deleteResultsHandler(req, res);

                expect(res.statusCode).toBe(200);
                expect(res.body).toEqual({
                    success: true,
                    message: `Public benchmark ${VALID_RUN_ID} successfully pulled back to unlisted.`
                });
                expect(deleteResult).not.toHaveBeenCalled();
                expect(writeResult).toHaveBeenCalledWith(
                    VALID_RUN_ID,
                    expect.objectContaining({
                        review: expect.objectContaining({
                            history: expect.arrayContaining([
                                expect.objectContaining({ status: publicState, by: 'admin' }),
                                expect.objectContaining({ status: 'unlisted', by: 'alice' })
                            ])
                        })
                    }),
                    'unlisted',
                    'alice'
                );
            }
        );
    });

    describe('DELETE /api/results/:runId — administrator access (any benchmark)', () => {
        it.each(['unlisted', 'rejected'])(
            'allows an admin to permanently delete another user\'s %s benchmark from GCS',
            async (state) => {
                vi.mocked(validateGitHubToken).mockResolvedValueOnce({ username: 'admin-user', permission: 'admin' });
                vi.mocked(readResultMetadata).mockResolvedValueOnce({ user: 'alice', state });
                vi.mocked(deleteResult).mockResolvedValueOnce(undefined);

                const { req, res } = createMockReqRes({ token: 'admin-token' });
                await deleteResultsHandler(req, res);

                expect(res.statusCode).toBe(200);
                expect(res.body).toEqual({
                    success: true,
                    message: `Benchmark ${VALID_RUN_ID} successfully deleted.`
                });
                expect(deleteResult).toHaveBeenCalledWith(VALID_RUN_ID);
                expect(writeResult).not.toHaveBeenCalled();
            }
        );

        it('allows an admin to withdraw another user\'s submitted_pending_review benchmark to unlisted while preserving original owner attribution', async () => {
            vi.mocked(validateGitHubToken).mockResolvedValueOnce({ username: 'admin-user', permission: 'admin' });
            vi.mocked(readResultMetadata).mockResolvedValueOnce({ user: 'alice', state: 'submitted_pending_review' });
            vi.mocked(readResultPayload).mockResolvedValueOnce({ runId: VALID_RUN_ID });
            vi.mocked(writeResult).mockResolvedValueOnce(undefined);

            const { req, res } = createMockReqRes({ token: 'admin-token' });
            await deleteResultsHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body.message).toMatch(/withdrawn to unlisted/i);
            expect(deleteResult).not.toHaveBeenCalled();

            const [calledRunId, updatedPayload, newState, preservedOwner] = vi.mocked(writeResult).mock.calls[0];
            expect(calledRunId).toBe(VALID_RUN_ID);
            expect(newState).toBe('unlisted');
            expect(preservedOwner).toBe('alice');
            expect(updatedPayload.review.history.at(-1)).toMatchObject({
                status: 'unlisted',
                by: 'admin-user'
            });
        });

        it.each(['public', 'promoted'])(
            'allows an admin to unlist another user\'s %s benchmark back to unlisted while preserving original owner attribution',
            async (publicState) => {
                vi.mocked(validateGitHubToken).mockResolvedValueOnce({ username: 'admin-user', permission: 'admin' });
                vi.mocked(readResultMetadata).mockResolvedValueOnce({ user: 'alice', state: publicState });
                vi.mocked(readResultPayload).mockResolvedValueOnce({ runId: VALID_RUN_ID });
                vi.mocked(writeResult).mockResolvedValueOnce(undefined);

                const { req, res } = createMockReqRes({ token: 'admin-token' });
                await deleteResultsHandler(req, res);

                expect(res.statusCode).toBe(200);
                expect(res.body.message).toMatch(/pulled back to unlisted/i);
                expect(deleteResult).not.toHaveBeenCalled();
                expect(writeResult).toHaveBeenCalledWith(
                    VALID_RUN_ID,
                    expect.objectContaining({
                        review: {
                            history: [expect.objectContaining({ status: 'unlisted', by: 'admin-user' })]
                        }
                    }),
                    'unlisted',
                    'alice'
                );
            }
        );
    });

    describe('DELETE /api/results/:runId — stateful double-delete workflow', () => {
        it('demotes a public benchmark to unlisted on first DELETE, then permanently deletes from GCS on second DELETE', async () => {
            // Simulated in-memory GCS state
            let storeRecord = {
                user: 'alice',
                state: 'public',
                payload: { runId: VALID_RUN_ID, review: { history: [] } }
            };

            vi.mocked(validateGitHubToken).mockResolvedValue({ username: 'alice', permission: 'user' });
            vi.mocked(readResultMetadata).mockImplementation(async () =>
                storeRecord ? { user: storeRecord.user, state: storeRecord.state } : null
            );
            vi.mocked(readResultPayload).mockImplementation(async () => structuredClone(storeRecord.payload));
            vi.mocked(writeResult).mockImplementation(async (_id, payload, newState, user) => {
                storeRecord = { user, state: newState, payload };
            });
            vi.mocked(deleteResult).mockImplementation(async () => {
                storeRecord = null;
            });

            // 1st DELETE: public -> unlisted
            const call1 = createMockReqRes({ token: 'alice-token' });
            await deleteResultsHandler(call1.req, call1.res);
            expect(call1.res.statusCode).toBe(200);
            expect(storeRecord).not.toBeNull();
            expect(storeRecord.state).toBe('unlisted');
            expect(writeResult).toHaveBeenCalledTimes(1);
            expect(deleteResult).not.toHaveBeenCalled();

            // 2nd DELETE: unlisted -> permanently deleted off GCS
            const call2 = createMockReqRes({ token: 'alice-token' });
            await deleteResultsHandler(call2.req, call2.res);
            expect(call2.res.statusCode).toBe(200);
            expect(storeRecord).toBeNull();
            expect(deleteResult).toHaveBeenCalledTimes(1);

            // 3rd DELETE: 404 Not Found
            const call3 = createMockReqRes({ token: 'alice-token' });
            await deleteResultsHandler(call3.req, call3.res);
            expect(call3.res.statusCode).toBe(404);
        });
    });

    describe('DELETE /api/results/:runId — playground mode', () => {
        it('allows anonymous withdrawal and deletion without a token when playground mode is enabled', async () => {
            vi.mocked(isPlaygroundMode).mockReturnValue(true);
            vi.mocked(readResultMetadata).mockResolvedValueOnce({ user: 'alice', state: 'submitted_pending_review' });
            vi.mocked(readResultPayload).mockResolvedValueOnce({ runId: VALID_RUN_ID });
            vi.mocked(writeResult).mockResolvedValueOnce(undefined);

            const { req, res } = createMockReqRes({ token: undefined });
            await deleteResultsHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(writeResult).toHaveBeenCalledWith(
                VALID_RUN_ID,
                expect.objectContaining({
                    review: {
                        history: [expect.objectContaining({ status: 'unlisted', by: 'anonymous' })]
                    }
                }),
                'unlisted',
                'alice'
            );
        });
    });

    describe('POST /api/results/:runId/promote vs POST /api/results/:runId/review — role separation', () => {
        it('allows the submitting owner to promote their own unlisted benchmark to submitted_pending_review', async () => {
            vi.mocked(validateGitHubToken).mockResolvedValueOnce({ username: 'alice', permission: 'user' });
            vi.mocked(readResultMetadata).mockResolvedValueOnce({ user: 'alice', state: 'unlisted' });
            vi.mocked(readResultPayload).mockResolvedValueOnce({ runId: VALID_RUN_ID });
            vi.mocked(writeResult).mockResolvedValueOnce(undefined);

            const { req, res } = createMockReqRes({
                token: 'alice-token',
                body: { status: 'submitted_pending_review' }
            });
            await promoteResultsHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body.state).toBe('submitted_pending_review');
            expect(writeResult).toHaveBeenCalledWith(
                VALID_RUN_ID,
                expect.any(Object),
                'submitted_pending_review',
                'alice'
            );
        });

        it('allows the submitting owner to resubmit their own rejected benchmark via /promote', async () => {
            vi.mocked(validateGitHubToken).mockResolvedValueOnce({ username: 'alice', permission: 'user' });
            vi.mocked(readResultMetadata).mockResolvedValueOnce({ user: 'alice', state: 'rejected' });
            vi.mocked(readResultPayload).mockResolvedValueOnce({ runId: VALID_RUN_ID });
            vi.mocked(writeResult).mockResolvedValueOnce(undefined);
            vi.mocked(processSubmission).mockResolvedValueOnce({
                success: true,
                state: 'submitted_pending_review'
            });

            const { req, res } = createMockReqRes({
                token: 'alice-token',
                body: { status: 'submitted_pending_processing' }
            });
            await promoteResultsHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body.state).toBe('submitted_pending_review');
            expect(processSubmission).toHaveBeenCalledWith(VALID_RUN_ID);
        });

        it('forbids an admin from promoting another user\'s unlisted or rejected benchmark (owner-only)', async () => {
            for (const state of ['unlisted', 'rejected']) {
                vi.mocked(validateGitHubToken).mockResolvedValueOnce({ username: 'admin-user', permission: 'admin' });
                vi.mocked(readResultMetadata).mockResolvedValueOnce({ user: 'alice', state });

                const { req, res } = createMockReqRes({
                    token: 'admin-token',
                    body: { status: 'submitted_pending_review' }
                });
                await promoteResultsHandler(req, res);

                expect(res.statusCode).toBe(403);
                expect(res.body.error).toMatch(/Only the submitting user \(owner\) can promote/i);
                expect(writeResult).not.toHaveBeenCalled();
            }
        });

        it('forbids the submitting owner (non-admin) from approving or rejecting their own benchmark via /review', async () => {
            for (const targetStatus of ['public', 'promoted', 'rejected']) {
                vi.mocked(validateGitHubToken).mockResolvedValueOnce({ username: 'alice', permission: 'user' });

                const { req, res } = createMockReqRes({
                    token: 'alice-token',
                    body: { status: targetStatus }
                });
                await reviewResultsHandler(req, res);

                expect(res.statusCode).toBe(403);
                expect(res.body.error).toMatch(/Admin privileges required/i);
                expect(writeResult).not.toHaveBeenCalled();
            }
        });

        it('allows an admin to approve or reject a submission via /review', async () => {
            vi.mocked(validateGitHubToken).mockResolvedValueOnce({ username: 'admin-user', permission: 'admin' });
            vi.mocked(readResultMetadata).mockResolvedValueOnce({ user: 'alice', state: 'submitted_pending_review' });
            vi.mocked(readResultPayload).mockResolvedValueOnce({ runId: VALID_RUN_ID });
            vi.mocked(writeResult).mockResolvedValueOnce(undefined);

            const { req, res } = createMockReqRes({
                token: 'admin-token',
                body: { status: 'public', feedback: 'LGTM' }
            });
            await reviewResultsHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body.state).toBe('public');
            expect(writeResult).toHaveBeenCalledWith(
                VALID_RUN_ID,
                expect.objectContaining({
                    feedback: 'LGTM',
                    review: expect.objectContaining({
                        reviewer: 'admin-user'
                    })
                }),
                'public',
                'alice'
            );
        });

        it('allows anonymous callers in Playground Mode to promote and review benchmarks', async () => {
            vi.mocked(isPlaygroundMode).mockReturnValue(true);

            // 1. Anonymous promote: unlisted -> submitted_pending_review
            vi.mocked(readResultMetadata).mockResolvedValueOnce({ user: 'alice', state: 'unlisted' });
            vi.mocked(readResultPayload).mockResolvedValueOnce({ runId: VALID_RUN_ID });
            vi.mocked(writeResult).mockResolvedValueOnce(undefined);

            const promoteCall = createMockReqRes({
                token: undefined,
                body: { status: 'submitted_pending_review' }
            });
            await promoteResultsHandler(promoteCall.req, promoteCall.res);
            expect(promoteCall.res.statusCode).toBe(200);
            expect(promoteCall.res.body.state).toBe('submitted_pending_review');

            // 2. Anonymous review: submitted_pending_review -> public
            vi.mocked(readResultMetadata).mockResolvedValueOnce({ user: 'alice', state: 'submitted_pending_review' });
            vi.mocked(readResultPayload).mockResolvedValueOnce({ runId: VALID_RUN_ID });
            vi.mocked(writeResult).mockResolvedValueOnce(undefined);

            const reviewCall = createMockReqRes({
                token: undefined,
                body: { status: 'public' }
            });
            await reviewResultsHandler(reviewCall.req, reviewCall.res);
            expect(reviewCall.res.statusCode).toBe(200);
            expect(reviewCall.res.body.state).toBe('public');
        });

        it('rejects invalid upward transitions on /promote and invalid target statuses on /review', async () => {
            // /promote from already public state -> 400
            vi.mocked(validateGitHubToken).mockResolvedValueOnce({ username: 'alice', permission: 'user' });
            vi.mocked(readResultMetadata).mockResolvedValueOnce({ user: 'alice', state: 'public' });

            const badPromote = createMockReqRes({
                token: 'alice-token',
                body: { status: 'submitted_pending_review' }
            });
            await promoteResultsHandler(badPromote.req, badPromote.res);
            expect(badPromote.res.statusCode).toBe(400);
            expect(badPromote.res.body.error).toMatch(/cannot be promoted/i);

            // /review with a promotion status -> 400
            vi.mocked(validateGitHubToken).mockResolvedValueOnce({ username: 'admin-user', permission: 'admin' });

            const badReview = createMockReqRes({
                token: 'admin-token',
                body: { status: 'submitted_pending_review' }
            });
            await reviewResultsHandler(badReview.req, badReview.res);
            expect(badReview.res.statusCode).toBe(400);
            expect(badReview.res.body.error).toMatch(/Invalid review status/i);
        });

        it('executes the full multi-step benchmark lifecycle across promote, review, withdraw/unlist, and permanent delete', async () => {
            let storeRecord = {
                user: 'alice',
                state: 'unlisted',
                payload: { runId: VALID_RUN_ID }
            };

            vi.mocked(readResultMetadata).mockImplementation(async () => {
                if (!storeRecord) return null;
                return { user: storeRecord.user, state: storeRecord.state };
            });
            vi.mocked(readResultPayload).mockImplementation(async () => {
                if (!storeRecord) throw new Error('Not found');
                return structuredClone(storeRecord.payload);
            });
            vi.mocked(writeResult).mockImplementation(async (_runId, payload, newState, user) => {
                storeRecord = { user, state: newState, payload: structuredClone(payload) };
            });
            vi.mocked(deleteResult).mockImplementation(async () => {
                storeRecord = null;
            });
            vi.mocked(processSubmission).mockImplementation(async () => {
                storeRecord.state = 'submitted_pending_review';
                return { success: true, state: 'submitted_pending_review' };
            });
            vi.mocked(validateGitHubToken).mockImplementation(async (token) => {
                if (token === 'alice-token') return { username: 'alice', permission: 'user' };
                if (token === 'admin-token') return { username: 'admin-user', permission: 'admin' };
                throw new Error('Invalid token');
            });

            // 1. Owner promotes unlisted -> submitted_pending_review
            const step1 = createMockReqRes({
                token: 'alice-token',
                body: { status: 'submitted_pending_review' }
            });
            await promoteResultsHandler(step1.req, step1.res);
            expect(step1.res.statusCode).toBe(200);
            expect(storeRecord.state).toBe('submitted_pending_review');

            // 2. Admin approves submitted_pending_review -> public
            const step2 = createMockReqRes({
                token: 'admin-token',
                body: { status: 'public' }
            });
            await reviewResultsHandler(step2.req, step2.res);
            expect(step2.res.statusCode).toBe(200);
            expect(storeRecord.state).toBe('public');

            // 3. Owner unlists public -> unlisted via DELETE
            const step3 = createMockReqRes({ token: 'alice-token' });
            await deleteResultsHandler(step3.req, step3.res);
            expect(step3.res.statusCode).toBe(200);
            expect(storeRecord.state).toBe('unlisted');

            // 4. Owner promotes unlisted -> submitted_pending_review again
            const step4 = createMockReqRes({
                token: 'alice-token',
                body: { status: 'submitted_pending_review' }
            });
            await promoteResultsHandler(step4.req, step4.res);
            expect(step4.res.statusCode).toBe(200);
            expect(storeRecord.state).toBe('submitted_pending_review');

            // 5. Admin rejects submitted_pending_review -> rejected with feedback
            const step5 = createMockReqRes({
                token: 'admin-token',
                body: { status: 'rejected', feedback: 'Missing manifest details' }
            });
            await reviewResultsHandler(step5.req, step5.res);
            expect(step5.res.statusCode).toBe(200);
            expect(storeRecord.state).toBe('rejected');
            expect(storeRecord.payload.feedback).toBe('Missing manifest details');

            // 6. Owner resubmits rejected -> submitted_pending_processing -> submitted_pending_review
            const step6 = createMockReqRes({
                token: 'alice-token',
                body: { status: 'submitted_pending_processing' }
            });
            await promoteResultsHandler(step6.req, step6.res);
            expect(step6.res.statusCode).toBe(200);
            expect(storeRecord.state).toBe('submitted_pending_review');

            // 7. Double-delete: 1st DELETE withdraws submitted_pending_review -> unlisted
            const step7 = createMockReqRes({ token: 'alice-token' });
            await deleteResultsHandler(step7.req, step7.res);
            expect(step7.res.statusCode).toBe(200);
            expect(storeRecord.state).toBe('unlisted');
            expect(deleteResult).not.toHaveBeenCalled();

            // 8. Double-delete: 2nd DELETE permanently purges unlisted from GCS
            const step8 = createMockReqRes({ token: 'alice-token' });
            await deleteResultsHandler(step8.req, step8.res);
            expect(step8.res.statusCode).toBe(200);
            expect(storeRecord).toBeNull();
            expect(deleteResult).toHaveBeenCalledTimes(1);

            // 9. Subsequent DELETE returns 404
            const step9 = createMockReqRes({ token: 'alice-token' });
            await deleteResultsHandler(step9.req, step9.res);
            expect(step9.res.statusCode).toBe(404);
        });
    });
});
