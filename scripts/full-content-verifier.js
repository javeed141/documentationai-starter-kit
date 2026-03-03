const fs = require('fs');
const path = require('path');
const https = require('https');

const config = require('./migration-config.json');

class FullContentVerifier {
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    this.sourceBaseUrl = config.sourceBaseUrl;
    this.rateLimitMs = 300;
    this.results = {
      verified: [],
      contentMismatch: [],
      source404: [],
      sourceErrors: [],
      localMissing: []
    };
  }

  async fetchUrl(url) {
    return new Promise((resolve, reject) => {
      const request = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; MigrationVerifier/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          const redirectUrl = response.headers.location.startsWith('http') 
            ? response.headers.location 
            : `${this.sourceBaseUrl}${response.headers.location}`;
          this.fetchUrl(redirectUrl).then(resolve).catch(reject);
          return;
        }
        
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => resolve({
          statusCode: response.statusCode,
          content: data,
          url
        }));
      });
      
      request.on('error', reject);
      request.setTimeout(30000, () => {
        request.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  extractTextContent(html) {
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');

    text = text
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();

    return text;
  }

  extractMdxTextContent(mdxContent) {
    const frontmatterMatch = mdxContent.match(/^---\n([\s\S]*?)\n---/);
    let body = mdxContent;
    
    if (frontmatterMatch) {
      body = mdxContent.slice(frontmatterMatch[0].length).trim();
    }

    return body
      .replace(/<[^>]+>/g, ' ')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[#*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  normalizeText(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  calculateSimilarity(text1, text2) {
    const norm1 = this.normalizeText(text1);
    const norm2 = this.normalizeText(text2);
    
    if (norm1 === norm2) return 1.0;
    if (!norm1 || !norm2) return 0.0;

    const words1 = new Set(norm1.split(' '));
    const words2 = new Set(norm2.split(' '));
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  extractNavigationPaths(navObj, paths = [], prefix = '') {
    if (Array.isArray(navObj)) {
      for (const item of navObj) {
        this.extractNavigationPaths(item, paths, prefix);
      }
    } else if (typeof navObj === 'object' && navObj !== null) {
      if (navObj.path) {
        paths.push(navObj.path);
      }
      if (navObj.pages) {
        this.extractNavigationPaths(navObj.pages, paths, prefix);
      }
      if (navObj.groups) {
        this.extractNavigationPaths(navObj.groups, paths, prefix);
      }
      if (navObj.tabs) {
        this.extractNavigationPaths(navObj.tabs, paths, prefix);
      }
      if (navObj.versions) {
        this.extractNavigationPaths(navObj.versions, paths, prefix);
      }
    }
    return paths;
  }

  pathToSourceUrl(localPath) {
    if (localPath.startsWith('v3/')) {
      return `${this.sourceBaseUrl}/${localPath}`;
    }
    return `${this.sourceBaseUrl}/${localPath}`;
  }

  async verifyPage(localPath) {
    const sourceUrl = this.pathToSourceUrl(localPath);
    const localFilePath = path.join(this.workspaceRoot, `${localPath}.mdx`);
    
    const result = {
      localPath,
      sourceUrl,
      status: 'pending',
      similarity: null,
      error: null,
      sourceStatus: null,
      localExists: false,
      sourceTextLength: 0,
      localTextLength: 0
    };

    if (!fs.existsSync(localFilePath)) {
      result.status = 'local_missing';
      result.localExists = false;
      return result;
    }
    result.localExists = true;

    try {
      const response = await this.fetchUrl(sourceUrl);
      result.sourceStatus = response.statusCode;
      
      if (response.statusCode === 404) {
        result.status = 'source_404';
        return result;
      }
      
      if (response.statusCode !== 200) {
        result.status = 'source_error';
        result.error = `HTTP ${response.statusCode}`;
        return result;
      }

      const sourceText = this.extractTextContent(response.content);
      const mdxContent = fs.readFileSync(localFilePath, 'utf-8');
      const localText = this.extractMdxTextContent(mdxContent);

      result.sourceTextLength = sourceText.length;
      result.localTextLength = localText.length;
      result.similarity = this.calculateSimilarity(sourceText, localText);

      if (result.similarity >= 0.6) {
        result.status = 'verified';
      } else {
        result.status = 'content_mismatch';
      }

    } catch (error) {
      result.status = 'error';
      result.error = error.message;
    }

    return result;
  }

  async verifyAllNavigationPages() {
    const navPath = path.join(this.workspaceRoot, 'documentation.json');
    const navContent = JSON.parse(fs.readFileSync(navPath, 'utf-8'));
    
    const allPaths = this.extractNavigationPaths(navContent.navigation);
    const uniquePaths = [...new Set(allPaths)];
    
    console.log(`Found ${uniquePaths.length} unique paths in navigation\n`);

    const v4Paths = uniquePaths.filter(p => !p.startsWith('v3/'));
    const v3Paths = uniquePaths.filter(p => p.startsWith('v3/'));

    console.log(`v4 paths: ${v4Paths.length}`);
    console.log(`v3 paths: ${v3Paths.length}\n`);

    console.log('Verifying v4 pages...\n');
    for (let i = 0; i < v4Paths.length; i++) {
      const localPath = v4Paths[i];
      const result = await this.verifyPage(localPath);
      this.categorizeResult(result);
      
      const pct = Math.round(((i + 1) / v4Paths.length) * 100);
      const statusIcon = this.getStatusIcon(result.status);
      console.log(`[v4 ${pct}%] ${statusIcon} ${localPath} (${result.status}${result.similarity ? `, ${Math.round(result.similarity * 100)}%` : ''})`);
      
      await this.delay(this.rateLimitMs);
    }

    console.log('\nVerifying v3 pages...\n');
    for (let i = 0; i < v3Paths.length; i++) {
      const localPath = v3Paths[i];
      const result = await this.verifyPage(localPath);
      this.categorizeResult(result);
      
      const pct = Math.round(((i + 1) / v3Paths.length) * 100);
      const statusIcon = this.getStatusIcon(result.status);
      console.log(`[v3 ${pct}%] ${statusIcon} ${localPath} (${result.status}${result.similarity ? `, ${Math.round(result.similarity * 100)}%` : ''})`);
      
      await this.delay(this.rateLimitMs);
    }

    return this.generateReport();
  }

  getStatusIcon(status) {
    switch (status) {
      case 'verified': return '✓';
      case 'content_mismatch': return '!';
      case 'source_404': return '✗';
      case 'local_missing': return '?';
      default: return '⚠';
    }
  }

  categorizeResult(result) {
    switch (result.status) {
      case 'verified':
        this.results.verified.push(result);
        break;
      case 'content_mismatch':
        this.results.contentMismatch.push(result);
        break;
      case 'source_404':
        this.results.source404.push(result);
        break;
      case 'local_missing':
        this.results.localMissing.push(result);
        break;
      default:
        this.results.sourceErrors.push(result);
    }
  }

  generateReport() {
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        total: this.results.verified.length + 
               this.results.contentMismatch.length + 
               this.results.source404.length + 
               this.results.localMissing.length +
               this.results.sourceErrors.length,
        verified: this.results.verified.length,
        contentMismatch: this.results.contentMismatch.length,
        source404: this.results.source404.length,
        localMissing: this.results.localMissing.length,
        errors: this.results.sourceErrors.length
      },
      results: this.results
    };

    return report;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

async function main() {
  const workspaceRoot = path.resolve(__dirname, '..');
  const verifier = new FullContentVerifier(workspaceRoot);

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║     Full Content Verification - All Navigation Pages      ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const report = await verifier.verifyAllNavigationPages();

  console.log('\n' + '═'.repeat(60));
  console.log('VERIFICATION SUMMARY');
  console.log('═'.repeat(60));
  console.log(`Total pages checked: ${report.summary.total}`);
  console.log(`  ✓ Verified (content matches): ${report.summary.verified}`);
  console.log(`  ! Content mismatch: ${report.summary.contentMismatch}`);
  console.log(`  ✗ Source 404: ${report.summary.source404}`);
  console.log(`  ? Local file missing: ${report.summary.localMissing}`);
  console.log(`  ⚠ Errors: ${report.summary.errors}`);

  if (report.results.source404.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log('PAGES WITH SOURCE 404 (need attention):');
    console.log('─'.repeat(60));
    for (const item of report.results.source404) {
      console.log(`  ${item.localPath}`);
      console.log(`    Source URL: ${item.sourceUrl}`);
    }
  }

  if (report.results.contentMismatch.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log('PAGES WITH CONTENT MISMATCH:');
    console.log('─'.repeat(60));
    for (const item of report.results.contentMismatch) {
      console.log(`  ${item.localPath} (${Math.round(item.similarity * 100)}% similar)`);
      console.log(`    Source: ${item.sourceTextLength} chars, Local: ${item.localTextLength} chars`);
    }
  }

  const outputPath = path.join(__dirname, 'full-verification-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`\nDetailed results saved to: ${outputPath}`);

  return report;
}

module.exports = { FullContentVerifier, main };

if (require.main === module) {
  main().catch(console.error);
}
