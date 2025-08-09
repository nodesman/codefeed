#!/usr/bin/env node

import { Command } from 'commander';
import { simpleGit, SimpleGit } from 'simple-git';
import axios from 'axios';
import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import http from 'http';
import open from 'open';
import portfinder from 'portfinder';
import os from 'os';

const program = new Command();
const git: SimpleGit = simpleGit();

const CONFIG_DIR = '.codefeed';
const CONFIG_FILE = 'config.json';
const ANALYSES_DIR = 'analyses';
const HEURISTICS_FILE = 'heuristics.json';

interface Config {
  model: string;
  exclude?: string[];
}

interface AnalysisHeuristics {
    ignore_patterns: string[];
    file_groups: string[][];
}


interface FileSummary {
    file: string;
    summary: string;
    diff?: string;
}

interface GeminiAnalysisResponse {
    highLevelSummary: string;
    fileSummaries: FileSummary[];
}

interface BranchSummary {
    branch: string;
    highLevelSummary: string;
    summaries: FileSummary[];
    noisyChanges: string[];
    from: string;
    to: string;
}

interface AnalysisReport {
    id: string;
    createdAt: string;
    branches: BranchSummary[];
}

export async function runAnalysis(options: { force?: boolean } = {}): Promise<AnalysisReport | null> {
    const gitRoot = await git.revparse(['--show-toplevel']);
    const analysesDir = path.join(gitRoot, CONFIG_DIR, ANALYSES_DIR);
    const heuristicsPath = path.join(gitRoot, CONFIG_DIR, HEURISTICS_FILE);

    const remotes = await git.getRemotes();
    if (!remotes.some(remote => remote.name === 'origin')) {
        throw new Error("This repository does not have a remote named 'origin'. Please add one to continue.");
    }

    const config = await getConfiguration(gitRoot);
    
    console.log('Fetching latest changes...');
    await git.fetch();

    const branches = await getBranchesToAnalyze();
    const branchSummaries: BranchSummary[] = [];
    
    for (const branch of branches) {
      const remoteBranch = `origin/${branch}`;
      console.log(`
Analyzing branch: ${branch}`);

      const to = (await git.revparse(['HEAD']));
      const sincePoint = await getSincePointFromReflog(branch);

      let from = sincePoint && sincePoint !== to ? sincePoint : '';
      if (!from) {
        console.log('First run detected. Establishing a baseline for future analyses.');
        console.log('Run codefeed again after your next `git pull` to get your first summary.');
        // On the first run, we don't analyze anything. We just set a baseline.
        // The next run will have a `sincePoint` to compare against.
        continue; 
      }

      console.log(`Changes since last pull (${from.slice(0, 7)})...`);

      // --- Intelligent Analysis Step 1: Update and Apply Heuristics ---
      const commitHistory = await getCommitHistory(from, to);
      let oldHeuristics: AnalysisHeuristics = { ignore_patterns: [], file_groups: [] };
      if (fs.existsSync(heuristicsPath)) {
          oldHeuristics = JSON.parse(fs.readFileSync(heuristicsPath, 'utf-8'));
      }

      let heuristics: AnalysisHeuristics;
      if (commitHistory.length > 0) {
          console.log('Performing pre-analysis to update intelligent heuristics...');
          heuristics = await updateHeuristics(config.model, oldHeuristics, commitHistory);
          fs.writeFileSync(heuristicsPath, JSON.stringify(heuristics, null, 2));
          console.log(`Heuristics updated and saved to ${heuristicsPath}`);
      } else {
          heuristics = oldHeuristics;
      }
      // --- End of Step 1 ---
      
      // Check for existing analysis
      if (!options.force && fs.existsSync(analysesDir)) {
          const existingFiles = fs.readdirSync(analysesDir).filter(file => file.endsWith('.json'));
          let analysisExists = false;
          for (const file of existingFiles) {
              const filePath = path.join(analysesDir, file);
              try {
                  const report: AnalysisReport = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                  if (report.branches.some(b => b.branch === branch && b.from === from && b.to === to)) {
                      console.log(`Analysis for ${branch} between ${from.slice(0,7)} and ${to.slice(0,7)} already exists. Skipping.`);
                      analysisExists = true;
                      break;
                  }
              } catch (e) {
                  console.warn(`Could not parse existing analysis file: ${file}`);
              }
          }
          if (analysisExists) {
              continue;
          }
      }

      const allChangedFiles = commitHistory.flatMap(commit => commit.files);
      const { primaryFiles, noisyFiles } = getChangedFiles(allChangedFiles, heuristics.ignore_patterns);
      
      if (primaryFiles.length > 0) {
        console.log(`Found ${primaryFiles.length} changed file(s) to analyze.`);
        
        // --- Intelligent Analysis Step 2: Create Smart Batches ---
        const batches = createSmartBatches(primaryFiles, heuristics.file_groups, commitHistory);
        console.log(`Analyzing in ${batches.length} smart batch(es)...`);
        // --- End of Step 2 ---

        let allFileSummaries: FileSummary[] = [];
        
        for (let i = 0; i < batches.length; i++) {
          const batch = batches[i];
          console.log(`Analyzing batch ${i + 1} of ${batches.length}: ${batch.join(', ')}`);
          const batchDiff = await getGitDiff(from, to, ...batch);
          if (batchDiff) {
            const batchAnalysis = await summarizeEntireDiff(config.model, batchDiff, branch, batch);
            if (batchAnalysis && batchAnalysis.fileSummaries) {
              allFileSummaries.push(...batchAnalysis.fileSummaries);
            }
          }
        }
        
        const finalHighLevelSummary = await createFinalSummary(config.model, allFileSummaries, branch);

        const summariesWithDiffs = await Promise.all(allFileSummaries.map(async (summary) => {
            const diff = await getGitDiff(from, to, summary.file);
            return { ...summary, diff: diff ?? undefined };
        }));

        branchSummaries.push({
          branch,
          highLevelSummary: finalHighLevelSummary,
          summaries: summariesWithDiffs,
          noisyChanges: noisyFiles,
          from,
          to
        });

      } else if (noisyFiles.length > 0) {
        branchSummaries.push({
            branch,
            highLevelSummary: "No primary files to analyze.",
            summaries: [],
            noisyChanges: noisyFiles,
            from,
            to
        });
      } else {
        console.log('No new changes found.');
      }
    }

    if (branchSummaries.length === 0) {
      console.log('\nNo new changes detected on analyzed branches.');
      return null;
    }

    
    const timestamp = new Date().toISOString().replace(/:/g, '-') ;
    const report: AnalysisReport = {
        id: timestamp,
        createdAt: new Date().toISOString(),
        branches: branchSummaries,
    };

    if (!fs.existsSync(analysesDir)) {
        fs.mkdirSync(analysesDir, { recursive: true });
    }

    const reportPath = path.join(analysesDir, `${timestamp}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`Analysis saved to ${reportPath}`);

    return report;
}

export async function updateHeuristics(
    model: string,
    oldHeuristics: AnalysisHeuristics,
    commitHistory: { hash: string; message: string; files: string[] }[]
): Promise<AnalysisHeuristics> {
    const historyString = commitHistory.map(commit => 
        `Commit: ${commit.hash}\nMessage: ${commit.message}\nFiles:\n${commit.files.map(f => `- ${f}`).join('\n')}`
    ).join('\n\n');

    const prompt = `
        You are an expert senior software developer helping to create and update analysis rules for a git repository.

        Here are the existing analysis rules we have been using:
        ---
        ${JSON.stringify(oldHeuristics, null, 2)}
        ---

        Here is the detailed history of new commits that have been made since the last analysis:
        ---
        ${historyString}
        ---

        Your Task:
        Based on the new commit history, please provide an updated and merged set of heuristics.
        - Analyze the commit messages and file lists to identify new patterns.
        - If you see new files that are clearly noise (e.g., build artifacts, logs), add them to 'ignore_patterns'.
        - If you see new groups of files that are consistently changed together in the same commits, add them to 'file_groups'.
        - Preserve the existing rules unless the new commits provide a clear reason to change them.

        Your response MUST be a valid JSON object with the following structure:
        {
          "ignore_patterns": ["pattern1", "pattern2"],
          "file_groups": [
            ["path/to/fileA.ts", "path/to/fileB.ts"]
          ]
        }
    `;

    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await callGeminiApi(model, prompt);
            const jsonString = response.replace(/^```json\s*|```\s*$/g, '');
            const parsed = JSON.parse(jsonString);

            // Validate the structure
            if (Array.isArray(parsed.ignore_patterns) && Array.isArray(parsed.file_groups)) {
                return parsed;
            }
            console.warn(`Warning: Heuristics response was not in the expected format on attempt ${attempt}.`);
        } catch (error) {
            console.error(`Error parsing heuristics response on attempt ${attempt}:`, error);
            if (attempt === MAX_RETRIES) {
                console.error("All attempts to parse the heuristics response failed. Returning old heuristics.");
                return oldHeuristics;
            }
            console.log("Retrying...");
        }
    }
    
    return oldHeuristics;
}

export async function getCommitHistory(from: string, to: string): Promise<{ hash: string; message: string; files: string[] }[]> {
    const log = await git.log({
        from,
        to,
        '--name-status': null, // Show file status (A, M, D, etc.)
    });

    return log.all.map(commit => ({
        hash: commit.hash,
        message: commit.message,
        files: commit.diff?.files.map(file => file.file) ?? [],
    }));
}


export async function getSincePointFromReflog(branch: string): Promise<string | null> {
    try {
        const reflog = await git.raw(['reflog', 'show', `origin/${branch}`]);
        const pullLine = reflog.split('\n').find(line => line.includes('pull:'));
        
        if (pullLine) {
            const lines = reflog.split('\n');
            const pullIndex = lines.findIndex(line => line.includes('pull:'));
            if (pullIndex > 0) {
                const prevLine = lines[pullIndex];
                const match = prevLine.match(/^([a-f0-9]+)/);
                if (match) {
                    return match[1];
                }
            }
        }
    } catch (error) {
        // Silently fail
    }
    return null;
}

let server: http.Server | null = null;
let isAnalyzing = false;

program
  .name('codefeed')
  .description('Summarize git changes using AI.')
  .version('1.2.0')
  .action(async () => {
    const startServer = (): Promise<{ server: http.Server, url: string }> => {
        return new Promise(async (resolve) => {
            const port = await portfinder.getPortPromise();
            const gitRoot = await git.revparse(['--show-toplevel']);
            const analysesDir = path.join(gitRoot, CONFIG_DIR, ANALYSES_DIR);

            const serverInstance = http.createServer(async (req, res) => {
                if (req.url === '/' && req.method === 'GET') {
                    const html = generateDashboardHtml();
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(html);
                } else if (req.url === '/api/analyses' && req.method === 'GET') {
                    if (!fs.existsSync(analysesDir)) {
                        fs.mkdirSync(analysesDir, { recursive: true });
                    }
                    const files = fs.readdirSync(analysesDir).filter(file => file.endsWith('.json'));
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(files));
                } else if (req.url?.startsWith('/api/analysis/') && req.method === 'GET') {
                    const filename = req.url.split('/')[3];
                    const filePath = path.join(analysesDir, filename);
                    if (fs.existsSync(filePath)) {
                        const data = fs.readFileSync(filePath, 'utf-8');
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(data);
                    } else {
                        res.writeHead(404);
                        res.end();
                    }
                } else if (req.url === '/api/status' && req.method === 'GET') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ isAnalyzing }));
                } else {
                    res.writeHead(404);
                    res.end();
                }
            });

            serverInstance.listen(port, () => {
                const url = `http://localhost:${port}`;
                resolve({ server: serverInstance, url });
            });
        });
    };

    const doAnalysis = async (options: { force?: boolean } = {}) => {
        if (isAnalyzing) {
            console.log('Analysis already in progress.');
            return;
        }
        isAnalyzing = true;
        try {
            await runAnalysis(options);
        } catch (error) {
            handleError(error);
        } finally {
            isAnalyzing = false;
        }
    };

    const serverInfo = await startServer();
    server = serverInfo.server;
    console.log(`Dashboard is available at: ${serverInfo.url}`);

    const { openBrowser } = await inquirer.prompt([
        {
            type: 'confirm',
            name: 'openBrowser',
            message: 'Open in browser?',
            default: true
        }
    ]);

    if (openBrowser) {
        await open(serverInfo.url);
    }

    await doAnalysis(); // Start initial analysis and wait for it to complete

    let keepRunning = true;
    while(keepRunning) {
        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'What would you like to do next?',
                choices: ['Re-analyze', 'Exit'],
                default: 'Re-analyze',
            },
        ]);

        if (action === 'Exit') {
            keepRunning = false;
        } else if (action === 'Re-analyze') {
            await doAnalysis({ force: true });
        }
    }

    if (server) {
        server.close();
    }
  });

function handleError(error: any) {
    if (error instanceof Error && error.message.includes('API_KEY')) {
        console.error(`
❌ API Key Not Found!

Please make sure the ${error.message.split(' ')[0]} environment variable is set.
`);
    } else if (axios.isAxiosError(error)) {
        console.error('API Error:', error.response?.data || error.message);
    } else if (error instanceof Error) {
        console.error('Error:', error.message);
    } else {
        console.error('An unknown error occurred.');
    }
}

async function getDefaultBranch(): Promise<string> {
    const remoteInfo = await git.remote(['show', 'origin']);
    if (remoteInfo) {
        const headBranchMatch = remoteInfo.match(/HEAD branch: (.*)/);
        if (headBranchMatch && headBranchMatch[1]) {
            return headBranchMatch[1];
        }
    }
    const branchSummary = await git.branch();
    return branchSummary.current || 'main';
}

export async function getBranchesToAnalyze(): Promise<string[]> {
    const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
    const mainBranch = await getDefaultBranch();
    
    const branches = new Set([mainBranch]);
    if (currentBranch !== mainBranch) {
        branches.add(currentBranch);
    }

    return Array.from(branches);
}

export async function getConfiguration(gitRoot: string): Promise<Config> {
  const configPath = path.join(gitRoot, CONFIG_DIR, CONFIG_FILE);

  if (fs.existsSync(configPath)) {
    const configData = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(configData);
  } else {
    return await firstRunSetup(gitRoot);
  }
}

async function firstRunSetup(gitRoot: string): Promise<Config> {
  console.log('First run detected. Setting up codefeed...');

  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'model',
      message: 'Which AI model would you like to use by default?',
      choices: ['gpt-5', 'gemini-2.5-flash'],
      default: 'gemini-2.5-flash',
    },
  ]);

  const config: Config = { model: answers.model };
  const configDir = path.join(gitRoot, CONFIG_DIR);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const configPath = path.join(configDir, CONFIG_FILE);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`Configuration saved to ${configPath}`);

  await addToGitignore(gitRoot);

  return config;
}

async function addToGitignore(gitRoot: string) {
  const homeDir = os.homedir();
  const globalGitignorePath = path.join(homeDir, '.gitignore_global');
  if (fs.existsSync(globalGitignorePath)) {
    const globalGitignoreContent = fs.readFileSync(globalGitignorePath, 'utf-8');
    if (globalGitignoreContent.includes('.codefeed')) {
      console.log("'.codefeed' is already ignored in your global .gitignore_global file.");
      return;
    }
  }

  const gitignorePath = path.join(gitRoot, '.gitignore');
  const ignoreEntry = `
# codefeed configuration
.codefeed
`;

  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
    if (!gitignoreContent.includes('.codefeed')) {
      fs.appendFileSync(gitignorePath, ignoreEntry);
      console.log('Added .codefeed to .gitignore');
    }
  } else {
    fs.writeFileSync(gitignorePath, ignoreEntry);
    console.log('Created .gitignore and added .codefeed entry.');
  }
}

export function getChangedFiles(allFiles: string[], extraIgnorePatterns: string[] = []): { primaryFiles: string[], noisyFiles: string[] } {
    const noisyPatterns = [
        'package-lock.json',
        'yarn.lock',
        ...extraIgnorePatterns
    ];

    const noisyFiles = allFiles.filter(file => noisyPatterns.some(pattern => file.includes(pattern)));
    const primaryFiles = allFiles.filter(file => !noisyPatterns.some(pattern => file.includes(pattern)));

    return { primaryFiles, noisyFiles };
}

export function createSmartBatches(files: string[], groups: string[][], commitHistory: { hash: string; message: string; files: string[] }[]): string[][] {
    const batches: string[][] = [];
    const remainingFiles = new Set(files);

    // First, create batches from the heuristic file_groups
    for (const group of groups) {
        const batch = group.filter(file => remainingFiles.has(file));
        if (batch.length > 1) { // Only create a batch if more than one file from the group is present
            batches.push(batch);
            for (const file of batch) {
                remainingFiles.delete(file);
            }
        }
    }

    // Group remaining files by commit
    const commitFileMap = new Map<string, string[]>();
    for (const commit of commitHistory) {
        for (const file of commit.files) {
            if (remainingFiles.has(file)) {
                if (!commitFileMap.has(commit.hash)) {
                    commitFileMap.set(commit.hash, []);
                }
                commitFileMap.get(commit.hash)!.push(file);
                remainingFiles.delete(file);
            }
        }
    }

    for (const commitFiles of commitFileMap.values()) {
        if (commitFiles.length > 0) {
            batches.push(commitFiles);
        }
    }

    // Add any remaining files that might not have been in the commit history (edge case)
    if (remainingFiles.size > 0) {
        batches.push(Array.from(remainingFiles));
    }

    return batches;
}


export async function getGitDiff(from: string, to: string, ...files: string[]): Promise<string | null> {
  try {
    const diff = await git.diff([`${from}..${to}`, '--', ...files]);
    return diff;
  } catch (e) {
    console.warn(`Could not get diff for ${files.join(', ')}. It's possible the old commit hash is no longer available.`);
    return null;
  }
}

function isContextLengthError(error: any): boolean {
    if (axios.isAxiosError(error)) {
        const errorCode = error.response?.data?.error?.code;
        if (errorCode === 'context_length_exceeded') {
            return true;
        }
        const errorMessage = error.response?.data?.error?.message;
        if (typeof errorMessage === 'string' && errorMessage.includes('token limit')) {
            return true;
        }
    }
    return false;
}

function getTokenLimitForModel(model: string): number {
  const modelLower = model.toLowerCase();
  if (modelLower.includes('gemini')) {
    // Gemini models often have very large context windows
    return 1000000;
  }
  if (modelLower.includes('gpt-5')) {
    // GPT-5 has a smaller context window
    return 8000;
  }
  // A safe, conservative default for unknown models
  return 4000;
}

function estimateTokens(text: string): number {
  // A simple heuristic: 1 token is roughly 4 characters
  return Math.ceil(text.length / 4);
}

function splitDiffIntoChunks(diff: string, maxTokens: number): string[] {
    const chunks: string[] = [];
    const hunks = diff.split(/(?=^@@.*@@$)/m);
    let currentChunk = '';

    for (const hunk of hunks) {
        const hunkTokens = estimateTokens(hunk);
        const currentTokens = estimateTokens(currentChunk);

        if (currentTokens + hunkTokens > maxTokens && currentChunk) {
            chunks.push(currentChunk);
            currentChunk = '';
        }
        currentChunk += hunk;
    }
    if (currentChunk) {
        chunks.push(currentChunk);
    }
    return chunks;
}

export async function summarizeEntireDiff(model: string, diff: string, branchName: string, files: string[]): Promise<GeminiAnalysisResponse | null> {
    const prompt = `
        Please act as an expert code reviewer.
        Analyze the following git diff for the branch "${branchName}", which includes changes to the following files: ${files.join(', ')}.
        
        Your task is to provide two things:
        1. A concise, high-level summary of the overall changes in the branch.
        2. A summary for each file, focusing on the "why" behind the changes, not just the "what".

        Your response MUST be a valid JSON object with the following structure:
        {
          "highLevelSummary": "A summary of the entire branch's changes.",
          "fileSummaries": [
            { "file": "path/to/first/file.ts", "summary": "A concise summary of the changes in this file." },
            { "file": "path/to/second/file.ts", "summary": "A concise summary of the changes in this file." }
          ]
        }

        Diff:
        ---
        ${diff}
        ---
    `;
    
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await callGeminiApi(model, prompt);
            // Clean the response to ensure it's valid JSON
            const jsonString = response.replace(/^```json\s*|```\s*$/g, '');
            const parsed = JSON.parse(jsonString);

            // Basic validation
            if (parsed.highLevelSummary && Array.isArray(parsed.fileSummaries)) {
                return parsed;
            }
            console.warn(`Warning: AI response was not in the expected format on attempt ${attempt}.`, parsed);
        } catch (error) {
            console.error(`Error parsing AI response on attempt ${attempt}:`, error);
            if (attempt === MAX_RETRIES) {
                console.error("All attempts to parse the AI response failed.");
                return null;
            }
            console.log("Retrying...");
        }
    }
    return null;
}

export async function createFinalSummary(model: string, summaries: FileSummary[], branchName: string): Promise<string> {
    const combinedSummaries = summaries.map(s => `File: ${s.file}\nSummary: ${s.summary}`).join('\n\n');
    const prompt = `
        The following are file summaries for a large number of changes in the "${branchName}" branch.
        Please synthesize these into a single, coherent, high-level summary of the overall changes.
        Focus on the main themes and the overall story of the changes.

        File Summaries:
        ---
        ${combinedSummaries}
        ---
    `;
    
    try {
        // Since this is a high-level summary, we can use a powerful model.
        // We'll use Gemini here, but this could be configurable.
        const response = await callGeminiApi(model, prompt);
        return response;
    } catch (error) {
        console.error("Error creating final summary:", error);
        return "Could not generate a final high-level summary.";
    }
}

async function summarizeChanges(model: string, diff: string, branchName: string, fileName: string): Promise<string> {
  const primaryModelFn = model.toLowerCase().startsWith('gpt') ? callGptApi : (p: string) => callGeminiApi(model, p);
  const fallbackModelFn = model.toLowerCase().startsWith('gpt') ? (p: string) => callGeminiApi(model, p) : callGptApi;
  const fallbackModelName = model.toLowerCase().startsWith('gpt') ? 'Gemini' : 'GPT';

  const makeApiCall = async (prompt: string) => {
      try {
          return await primaryModelFn(prompt);
      } catch (error) {
          if (isContextLengthError(error)) {
              console.warn(`Warning: The diff is too long for ${model}. Attempting fallback with ${fallbackModelName}...`);
              return await fallbackModelFn(prompt);
          }
          throw error;
      }
  };


  const tokenLimit = getTokenLimitForModel(model);
  const diffTokens = estimateTokens(diff);

  if (diffTokens < tokenLimit) {
    console.log(`Sending request to ${model} for ${fileName} on ${branchName}...
`);
    const prompt = `
      Please provide a concise, high-level summary of the following git diff for the file "${fileName}" on the "${branchName}" branch.
      Focus on the "why" behind the changes, not just the "what".
      Describe the overall impact and purpose of the changes in this file.
      
      Diff:
      ---
      ${diff}
      ---
    `;
    return makeApiCall(prompt);
  } else {
    console.log(`Diff for ${fileName} is too large (${diffTokens} tokens for model ${model}). Starting map-reduce process...
`);
    
    // MAP step
    const chunks = splitDiffIntoChunks(diff, tokenLimit - 500); // Leave buffer for prompt
    const chunkSummaries: string[] = [];
    
    for (let i = 0; i < chunks.length; i++) {
        console.log(`Summarizing chunk ${i + 1} of ${chunks.length} for ${fileName}...
`);
        const chunkPrompt = `
            This is one chunk of a larger diff for the file "${fileName}". 
            Please provide a concise summary of this specific chunk.
            Focus on the purpose and impact of the changes within this chunk.

            Diff Chunk:
            ---
            ${chunks[i]}
            ---
        `;
        const chunkSummary = await makeApiCall(chunkPrompt);
        chunkSummaries.push(chunkSummary);
    }

    // REDUCE step
    console.log(`Combining ${chunkSummaries.length} chunk summaries for ${fileName}...
`);
    const combinedSummaries = chunkSummaries.join('\n\n---\n\n');
    const reducePrompt = `
        The following are several summaries of chunks from a single file's diff ("${fileName}").
        Please synthesize these into a single, coherent, high-level summary.
        Focus on the overall story of the changes, combining the individual points into a cohesive narrative.

        Chunk Summaries:
        ---
        ${combinedSummaries}
        ---
    `;
    
    return makeApiCall(reducePrompt);
  }
}

async function callGptApi(prompt: string): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY environment variable is not set.');
    }
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: "gpt-5",
        messages: [{ role: "user", content: prompt }]
    }, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        }
    });
    return response.data.choices[0].message.content.trim();
}

export async function callGeminiApi(model: string, prompt: string): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY environment variable is not set.');
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }] }]
    }, {
        headers: {
            'Content-Type': 'application/json'
        }
    });
    return response.data.candidates[0].content.parts[0].text.trim();
}

function generateDashboardHtml(): string {
    const dashboardPath = path.join(__dirname, 'dashboard.html');
    return fs.readFileSync(dashboardPath, 'utf-8');
}

function generateHtml(report: AnalysisReport): string {
    // This function is now a fallback, the main UI is the dashboard
    return generateDashboardHtml();
}

async function main() {
    program.parse(process.argv);
}

if (require.main === module) {
    main();
}