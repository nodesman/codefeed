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

interface Config {
  model: string;
  exclude?: string[];
}

interface FileSummary {
    file: string;
    summary: string;
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

async function runAnalysis(): Promise<AnalysisReport | null> {
    const gitRoot = await git.revparse(['--show-toplevel']);
    
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
      console.log(`\nAnalyzing branch: ${branch}`);

      const to = await git.revparse([remoteBranch]);
      const sincePoint = await getSincePointFromReflog(branch);

      const from = sincePoint && sincePoint !== to ? sincePoint : `${remoteBranch}~5`;
      if (sincePoint && sincePoint !== to) {
        console.log(`Changes since last pull (${sincePoint.slice(0, 7)})...`);
      } else {
        console.log('No previous pull found, summarizing last 5 commits...');
      }

      const { primaryFiles, noisyFiles } = await getChangedFiles(from, to);
      
      if (primaryFiles.length > 0) {
        console.log('Summarizing all files in a single request...');
        const entireDiff = await getGitDiff(from, to, ...primaryFiles);
        if (entireDiff) {
            const analysis = await summarizeEntireDiff(config.model, entireDiff, branch, primaryFiles);
            if (analysis) {
                branchSummaries.push({
                    branch,
                    highLevelSummary: analysis.highLevelSummary,
                    summaries: analysis.fileSummaries,
                    noisyChanges: noisyFiles,
                    from,
                    to
                });
            }
        }
      } else if (noisyFiles.length > 0) {
        // Handle case where there are only noisy files
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

    
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const report: AnalysisReport = {
        id: timestamp,
        createdAt: new Date().toISOString(),
        branches: branchSummaries,
    };

    const analysesDir = path.join(gitRoot, CONFIG_DIR, ANALYSES_DIR);
    if (!fs.existsSync(analysesDir)) {
        fs.mkdirSync(analysesDir, { recursive: true });
    }

    const reportPath = path.join(analysesDir, `${timestamp}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`Analysis saved to ${reportPath}`);

    return report;
}

async function getSincePointFromReflog(branch: string): Promise<string | null> {
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

program
  .name('codefeed')
  .description('Summarize git changes using AI.')
  .version('1.0.0')
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
                } else if (req.url === '/lint' && req.method === 'POST') {
                    let body = '';
                    req.on('data', chunk => {
                        body += chunk.toString();
                    });
                    req.on('end', async () => {
                        try {
                            const { file, from, to } = JSON.parse(body);
                            const lintResult = await lintFileWithGpt5(file, from, to);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ summary: lintResult }));
                        } catch (error) {
                            console.error('Linting error:', error);
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: 'Failed to process linting request' }));
                        }
                    });
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

    let keepRunning = true;
    while(keepRunning) {
        try {
            const report = await runAnalysis();
            if (report) {
                const serverInfo = await startServer();
                server = serverInfo.server;
                console.log(`\nDashboard is available at: ${serverInfo.url}`);

                const { openBrowser } = await inquirer.prompt([{ 
                    type: 'confirm',
                    name: 'openBrowser',
                    message: 'Open in browser?',
                    default: true
                }]);

                if (openBrowser) {
                    await open(serverInfo.url);
                }
            }
        } catch (error) {
            handleError(error);
        }

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
        }
        if (server) {
            server.close();
        }
    }
  });

function handleError(error: any) {
    if (axios.isAxiosError(error)) {
        console.error('API Error:', error.response?.data || error.message);
    } else if (error instanceof Error) {
        console.error('Error:', error.message);
    } else {
        console.error('An unknown error occurred.');
    }
}

async function lintFileWithGpt5(file: string, from: string, to: string): Promise<string> {
    console.log(`Requesting GPT-5 lint for ${file}...`);
    const diff = await getGitDiff(from, to, file);
    if (!diff) {
        return "Could not generate diff for linting.";
    }

    const prompt = `
        Please act as an expert code reviewer.
        Analyze the following git diff for the file "${file}".
        Provide a concise code review and style analysis.
        Identify potential bugs, style guide violations, or areas for improvement.
        Use markdown for formatting your response.

        Diff:
        ---
        ${diff}
        ---
    `;
    
    return callGptApi(prompt);
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

async function getBranchesToAnalyze(): Promise<string[]> {
    const currentBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
    const mainBranch = await getDefaultBranch();
    
    const branches = new Set([mainBranch]);
    if (currentBranch !== mainBranch) {
        branches.add(currentBranch);
    }

    return Array.from(branches);
}

async function getConfiguration(gitRoot: string): Promise<Config> {
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
      choices: ['gpt-5', 'gemini-2.5-pro'],
      default: 'gemini-2.5-pro',
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
  const ignoreEntry = `\n# codefeed configuration\n.codefeed\n`;

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

async function getChangedFiles(from: string, to: string): Promise<{ primaryFiles: string[], noisyFiles: string[] }> {
    const noisyPatterns = [
        'package-lock.json',
        'yarn.lock',
    ];

    const allChanged = await git.diff([`${from}..${to}`, '--name-only']);
    const allFiles = allChanged.split('\n').filter(file => file.trim() !== '');

    const noisyFiles = allFiles.filter(file => noisyPatterns.some(pattern => file.includes(pattern)));
    const primaryFiles = allFiles.filter(file => !noisyPatterns.some(pattern => file.includes(pattern)));

    return { primaryFiles, noisyFiles };
}


async function getGitDiff(from: string, to: string, ...files: string[]): Promise<string | null> {
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

async function summarizeEntireDiff(model: string, diff: string, branchName: string, files: string[]): Promise<GeminiAnalysisResponse | null> {
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
    
    try {
        const response = await callGeminiApi(prompt);
        // Clean the response to ensure it's valid JSON
        const jsonString = response.replace(/^```json\s*|```\s*$/g, '');
        const parsed = JSON.parse(jsonString);

        // Basic validation
        if (parsed.highLevelSummary && Array.isArray(parsed.fileSummaries)) {
            return parsed;
        }
        console.warn("Warning: AI response was not in the expected format.", parsed);
        return null;
    } catch (error) {
        console.error("Error parsing AI response:", error);
        return null;
    }
}

async function summarizeChanges(model: string, diff: string, branchName: string, fileName: string): Promise<string> {
  const primaryModelFn = model.toLowerCase().startsWith('gpt') ? callGptApi : callGeminiApi;
  const fallbackModelFn = model.toLowerCase().startsWith('gpt') ? callGeminiApi : callGptApi;
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
    console.log(`Sending request to ${model} for ${fileName} on ${branchName}...`);
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
        console.log(`Summarizing chunk ${i + 1} of ${chunks.length} for ${fileName}...`);
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
    console.log(`Combining ${chunkSummaries.length} chunk summaries for ${fileName}...`);
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

async function callGeminiApi(prompt: string): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY environment variable is not set.');
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`;
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

program.parse(process.argv);
