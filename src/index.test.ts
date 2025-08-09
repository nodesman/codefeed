import { runAnalysis } from './index';
import * as index from './index';
import inquirer from 'inquirer';
import fs from 'fs';

jest.mock('simple-git', () => ({
    __esModule: true,
    simpleGit: jest.fn().mockReturnValue({
        revparse: jest.fn().mockResolvedValue('/path/to/repo'),
        getRemotes: jest.fn().mockResolvedValue([{ name: 'origin' }]),
        fetch: jest.fn().mockResolvedValue(undefined),
        log: jest.fn().mockResolvedValue({ all: [{ hash: 'abcdef' }] }),
        branch: jest.fn().mockResolvedValue({ current: 'main' }),
        raw: jest.fn().mockResolvedValue(''),
        diff: jest.fn().mockResolvedValue(''),
        remote: jest.fn().mockResolvedValue(''),
    }),
}));

jest.mock('inquirer', () => ({
    __esModule: true,
    default: {
        prompt: jest.fn().mockResolvedValue({ openBrowser: false, action: 'Exit' }),
    },
}));

describe('runAnalysis', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('should use batching when there are more than 10 files', async () => {
        const primaryFiles = Array.from({ length: 15 }, (_, i) => `file${i + 1}.ts`);
        const getChangedFilesSpy = jest.spyOn(index, 'getChangedFiles').mockResolvedValue({ primaryFiles, noisyFiles: [] });
        const getGitDiffSpy = jest.spyOn(index, 'getGitDiff').mockResolvedValue('dummy-diff');
        const summarizeEntireDiffSpy = jest.spyOn(index, 'summarizeEntireDiff').mockResolvedValue({
            highLevelSummary: 'summary',
            fileSummaries: [],
        });
        const createFinalSummarySpy = jest.spyOn(index, 'createFinalSummary').mockResolvedValue('final-summary');
        jest.spyOn(index, 'getConfiguration').mockResolvedValue({ model: 'gemini-2.5-pro' });
        jest.spyOn(index, 'getBranchesToAnalyze').mockResolvedValue(['main']);
        jest.spyOn(index, 'getSincePointFromReflog').mockResolvedValue('abcdef');
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readdirSync').mockReturnValue([]);

        await runAnalysis();

        expect(summarizeEntireDiffSpy).toHaveBeenCalledTimes(2);
        expect(createFinalSummarySpy).toHaveBeenCalledTimes(1);
    });

    it('should not use batching when there are 10 or fewer files', async () => {
        const primaryFiles = Array.from({ length: 5 }, (_, i) => `file${i + 1}.ts`);
        const getChangedFilesSpy = jest.spyOn(index, 'getChangedFiles').mockResolvedValue({ primaryFiles, noisyFiles: [] });
        const getGitDiffSpy = jest.spyOn(index, 'getGitDiff').mockResolvedValue('dummy-diff');
        const summarizeEntireDiffSpy = jest.spyOn(index, 'summarizeEntireDiff').mockResolvedValue({
            highLevelSummary: 'summary',
            fileSummaries: [],
        });
        const createFinalSummarySpy = jest.spyOn(index, 'createFinalSummary').mockResolvedValue('final-summary');
        jest.spyOn(index, 'getConfiguration').mockResolvedValue({ model: 'gemini-2.5-pro' });
        jest.spyOn(index, 'getBranchesToAnalyze').mockResolvedValue(['main']);
        jest.spyOn(index, 'getSincePointFromReflog').mockResolvedValue('abcdef');
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'readdirSync').mockReturnValue([]);

        await runAnalysis();

        expect(summarizeEntireDiffSpy).toHaveBeenCalledTimes(1);
        expect(createFinalSummarySpy).not.toHaveBeenCalled();
    });
});
