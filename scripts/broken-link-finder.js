const fs = require('fs');
const path = require('path');
const https = require('https');

class BrokenLinkFinder {
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    this.sourceBaseUrl = 'https://docs.datafiniti.co';
    this.results = {
      brokenInternalLinks: [],
      externalLinksToSource: [],
      linksToReadme: []
    };
    this.checkedUrls = new Map();
    this.rateLimitMs = 200;
  }

  getAllMdxFiles(dir = this.workspaceRoot, files = []) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'scripts') {
        continue;
      }
      
      if (entry.isDirectory()) {
        this.getAllMdxFiles(fullPath, files);
      } else if (entry.name.endsWith('.mdx')) {
        files.push(fullPath);
      }
    }
    
    return files;
  }

  extractLinks(content, filePath) {
    const links = [];
    const lines = content.split('\n');
    
    const mdLinkRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
    const hrefRegex = /href=["']([^"']+)["']/g;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      
      let match;
      while ((match = mdLinkRegex.exec(line)) !== null) {
        links.push({
          text: match[1],
          url: match[2],
          line: lineNum,
          filePath
        });
      }
      
      while ((match = hrefRegex.exec(line)) !== null) {
        links.push({
          text: '',
          url: match[1],
          line: lineNum,
          filePath
        });
      }
    }
    
    return links;
  }

  async checkUrl(url) {
    if (this.checkedUrls.has(url)) {
      return this.checkedUrls.get(url);
    }

    return new Promise((resolve) => {
      const request = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LinkChecker/1.0)'
        }
      }, (response) => {
        const result = {
          statusCode: response.statusCode,
          ok: response.statusCode >= 200 && response.statusCode < 400
        };
        this.checkedUrls.set(url, result);
        resolve(result);
      });
      
      request.on('error', () => {
        const result = { statusCode: 0, ok: false };
        this.checkedUrls.set(url, result);
        resolve(result);
      });
      
      request.setTimeout(10000, () => {
        request.destroy();
        const result = { statusCode: 0, ok: false };
        this.checkedUrls.set(url, result);
        resolve(result);
      });
    });
  }

  isInternalLink(url) {
    return url.startsWith('/') || 
           url.startsWith('./') || 
           url.startsWith('../') ||
           url.startsWith('docs/') ||
           url.startsWith('v3/') ||
           url.startsWith('reference/') ||
           url.startsWith('changelog/');
  }

  isSourceLink(url) {
    return url.includes('docs.datafiniti.co');
  }

  isReadmeLink(url) {
    return url.includes('readme.io') || url.includes('readme.com');
  }

  resolveInternalLink(url, filePath) {
    if (url.startsWith('http')) {
      return url;
    }
    
    let cleanUrl = url.split('#')[0].split('?')[0];
    
    if (cleanUrl.startsWith('/')) {
      cleanUrl = cleanUrl.slice(1);
    }
    
    if (!cleanUrl.endsWith('.mdx')) {
      cleanUrl = cleanUrl + '.mdx';
    }
    
    return path.join(this.workspaceRoot, cleanUrl);
  }

  async scanFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(this.workspaceRoot, filePath);
    const links = this.extractLinks(content, relativePath);
    
    for (const link of links) {
      if (this.isSourceLink(link.url)) {
        const result = await this.checkUrl(link.url);
        if (!result.ok) {
          this.results.brokenInternalLinks.push({
            ...link,
            type: 'source_link_404',
            statusCode: result.statusCode
          });
        } else {
          this.results.externalLinksToSource.push(link);
        }
        await this.delay(this.rateLimitMs);
      } else if (this.isReadmeLink(link.url)) {
        this.results.linksToReadme.push(link);
      } else if (this.isInternalLink(link.url) && !link.url.startsWith('http')) {
        const resolvedPath = this.resolveInternalLink(link.url, filePath);
        if (!fs.existsSync(resolvedPath)) {
          this.results.brokenInternalLinks.push({
            ...link,
            type: 'local_file_missing',
            resolvedPath
          });
        }
      }
    }
  }

  async scanAll() {
    const files = this.getAllMdxFiles();
    console.log(`Scanning ${files.length} MDX files for broken links...\n`);
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const relativePath = path.relative(this.workspaceRoot, file);
      const pct = Math.round(((i + 1) / files.length) * 100);
      
      process.stdout.write(`\r[${pct}%] Scanning: ${relativePath.slice(0, 50).padEnd(50)}`);
      
      await this.scanFile(file);
    }
    
    console.log('\n');
    return this.generateReport();
  }

  generateReport() {
    return {
      timestamp: new Date().toISOString(),
      summary: {
        brokenLinks: this.results.brokenInternalLinks.length,
        linksToSource: this.results.externalLinksToSource.length,
        linksToReadme: this.results.linksToReadme.length
      },
      results: this.results
    };
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

async function main() {
  const workspaceRoot = path.resolve(__dirname, '..');
  const finder = new BrokenLinkFinder(workspaceRoot);

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           Broken Link Finder - Content Analysis            ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const report = await finder.scanAll();

  console.log('═'.repeat(60));
  console.log('LINK ANALYSIS SUMMARY');
  console.log('═'.repeat(60));
  console.log(`Broken internal links: ${report.summary.brokenLinks}`);
  console.log(`Links to source (docs.datafiniti.co): ${report.summary.linksToSource}`);
  console.log(`Links to Readme: ${report.summary.linksToReadme}`);

  if (report.results.brokenInternalLinks.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log('BROKEN LINKS:');
    console.log('─'.repeat(60));
    
    const byFile = {};
    for (const link of report.results.brokenInternalLinks) {
      if (!byFile[link.filePath]) byFile[link.filePath] = [];
      byFile[link.filePath].push(link);
    }
    
    for (const [file, links] of Object.entries(byFile)) {
      console.log(`\n${file}:`);
      for (const link of links) {
        console.log(`  Line ${link.line}: ${link.url}`);
        if (link.statusCode) console.log(`    Status: ${link.statusCode}`);
        if (link.resolvedPath) console.log(`    Expected: ${link.resolvedPath}`);
      }
    }
  }

  if (report.results.linksToReadme.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log('LINKS TO README (should be updated):');
    console.log('─'.repeat(60));
    
    const byFile = {};
    for (const link of report.results.linksToReadme) {
      if (!byFile[link.filePath]) byFile[link.filePath] = [];
      byFile[link.filePath].push(link);
    }
    
    for (const [file, links] of Object.entries(byFile).slice(0, 10)) {
      console.log(`\n${file}:`);
      for (const link of links.slice(0, 5)) {
        console.log(`  Line ${link.line}: ${link.url}`);
      }
      if (links.length > 5) console.log(`  ... and ${links.length - 5} more`);
    }
    
    if (Object.keys(byFile).length > 10) {
      console.log(`\n... and ${Object.keys(byFile).length - 10} more files`);
    }
  }

  const outputPath = path.join(__dirname, 'broken-links-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`\nDetailed results saved to: ${outputPath}`);

  return report;
}

module.exports = { BrokenLinkFinder, main };

if (require.main === module) {
  main().catch(console.error);
}
