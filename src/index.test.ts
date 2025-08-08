import { runAnalysis } from './index';
import * as index from './index';
import { simpleGit } from 'simple-git';

// Mock the entire module
jest.doMock('simple-git', () => ({
    __esModule: true,
    simpleGit: jest.fn().mockReturnValue({
        revparse: jest.fn().mockResolvedValue('/path/to/repo'),
        getRemotes: jest.fn().mockResolvedValue([{ name: 'origin' }]),
        fetch: jest.fn().mockResolvedValue(undefined),
        log: jest.fn().mockResolvedValue({ all: [{ hash: 'abcdef' }] }),
        branch: jest.fn().mockResolvedValue({ current: 'main' }),
        raw: jest.fn().mockResolvedValue(''),
    }),
}));

jest.mock('./index', () => {
    const originalModule = jest.requireActual('./index');
    return {
        ...originalModule,
        __esModule: true,
        getChangedFiles: jest.fn(),
        getGitDiff: jest.fn(),
        summarizeEntireDiff: jest.fn(),
        createFinalSummary: jest.fn(),
        getConfiguration: jest.fn().mockResolvedValue({ model: 'gemini-2.5-pro' }),
        getBranchesToAnalyze: jest.fn().mockResolvedValue(['main']),
        getSincePointFromReflog: jest.fn().mockResolvedValue('abcdef'),
    };
});

const mockedGetChangedFiles = index.getChangedFiles as jest.Mock;
const mockedGetGitDiff = index.getGitDiff as jest.Mock;
const mockedSummarizeEntireDiff = index.summarizeEntireDiff as jest.Mock;
const mockedCreateFinalSummary = index.createFinalSummary as jest.Mock;

describe('runAnalysis', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should use batching when there are more than 10 files', async () => {
        const primaryFiles = Array.from({ length: 15 }, (_, i) => `file${i + 1}.ts`);
        mockedGetChangedFiles.mockResolvedValue({ primaryFiles, noisyFiles: [] });
        mockedGetGitDiff.mockResolvedValue('dummy-diff');
        mockedSummarizeEntireDiff.mockResolvedValue({
            highLevelSummary: 'Batch summary',
            fileSummaries: [{ file: 'file1.ts', summary: 'summary' }],
        });
        mockedCreateFinalSummary.mockResolvedValue('Final summary');

        await runAnalysis();

        expect(mockedSummarizeEntireDiff).toHaveBeenCalledTimes(2); // 15 files, batch size 10, so 2 batches
        expect(mockedCreateFinalSummary).toHaveBeenCalledTimes(1);
    });

    it('should not use batching when there are 10 or fewer files', async () => {
        const primaryFiles = Array.from({ length: 5 }, (_, i) => `file${i + 1}.ts`);
        mockedGetChangedFiles.mockResolvedValue({ primaryFiles, noisyFiles: [] });
        mockedGetGitDiff.mockResolvedValue('dummy-diff');
        mockedSummarizeEntireDiff.mockResolvedValue({
            highLevelSummary: 'Single summary',
            fileSummaries: [{ file: 'file1.ts', summary: 'summary' }],
        });

        await runAnalysis();

        expect(mockedSummarizeEntireDiff).toHaveBeenCalledTimes(1);
        expect(mockedCreateFinalSummary).not.toHaveBeenCalled();
    });
});