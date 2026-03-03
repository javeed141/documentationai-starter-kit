const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE_DIR = path.join(__dirname, '..');
const SOURCE_BASE_V4 = 'https://docs.datafiniti.co/docs/';
const SOURCE_BASE_V3 = 'https://docs.datafiniti.co/v3/docs/';

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { 
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000
    }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        fetchUrl(response.headers.location).then(resolve).catch(reject);
        return;
      }
      
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve({ statusCode: response.statusCode, body: data }));
    });
    
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

function extractTextContent(html) {
  if (!html) return '';
  
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  
  return text;
}

function extractTitle(html) {
  const match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i) || 
                html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim().replace(/&amp;/g, '&') : null;
}

function extractMdxContent(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    let title = '';
    if (frontmatterMatch) {
      const titleMatch = frontmatterMatch[1].match(/title:\s*["']?([^"'\n]+)["']?/);
      if (titleMatch) title = titleMatch[1].trim();
    }
    
    const bodyContent = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
    
    const textContent = bodyContent
      .replace(/<[^>]+>/g, ' ')
      .replace(/```[\s\S]*?```/g, '[CODE]')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[#*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    return { title, content: textContent, raw: content, exists: true };
  } catch (err) {
    return { title: '', content: '', raw: '', exists: false, error: err.message };
  }
}

function extractAllPaths(navConfig) {
  const paths = [];
  
  function traverse(obj, isV3 = false) {
    if (Array.isArray(obj)) {
      obj.forEach(item => traverse(item, isV3));
    } else if (typeof obj === 'object' && obj !== null) {
      if (obj.version === 'v3.0') {
        isV3 = true;
      }
      
      if (obj.path && !obj.openapi && !obj.href) {
        paths.push({
          path: obj.path,
          title: obj.title || '',
          isV3: isV3 || obj.path.startsWith('v3/')
        });
      }
      
      Object.values(obj).forEach(val => traverse(val, isV3));
    }
  }
  
  traverse(navConfig);
  return paths;
}

function getSourceSlug(localPath) {
  let slug = localPath
    .replace(/^docs\//, '')
    .replace(/^v3\/docs\//, '')
    .replace(/^reference\//, '')
    .replace(/^v3\/reference\//, '')
    .replace(/\.mdx$/, '');
  
  return slug;
}

function extractKeyPhrases(text, count = 20) {
  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4);
  
  const phrases = [];
  for (let i = 0; i < words.length - 1; i++) {
    phrases.push(words[i] + ' ' + words[i + 1]);
  }
  
  return [...new Set(phrases)].slice(0, count);
}

function contentSimilarity(local, source) {
  const localPhrases = new Set(extractKeyPhrases(local, 50));
  const sourcePhrases = new Set(extractKeyPhrases(source, 50));
  
  if (localPhrases.size === 0 || sourcePhrases.size === 0) return 0;
  
  const intersection = [...localPhrases].filter(p => sourcePhrases.has(p)).length;
  const union = new Set([...localPhrases, ...sourcePhrases]).size;
  
  return intersection / union;
}

function extractHeadings(text) {
  const headingMatches = text.match(/^#{1,6}\s+.+$/gm) || [];
  return headingMatches.map(h => h.replace(/^#+\s+/, '').toLowerCase().trim());
}

function extractSourceHeadings(html) {
  const matches = html.match(/<h[1-6][^>]*>([^<]+)<\/h[1-6]>/gi) || [];
  return matches.map(h => h.replace(/<[^>]+>/g, '').toLowerCase().trim());
}

async function verifyPage(pageInfo, delay = 300) {
  const { path: pagePath, title, isV3 } = pageInfo;
  
  if (pagePath.startsWith('reference/') || pagePath.startsWith('v3/reference/')) {
    return { path: pagePath, status: 'skipped', reason: 'API reference page' };
  }
  
  if (pagePath.includes('changelog')) {
    return { path: pagePath, status: 'skipped', reason: 'Changelog page (consolidated)' };
  }
  
  const slug = getSourceSlug(pagePath);
  const sourceUrl = isV3 ? SOURCE_BASE_V3 + slug : SOURCE_BASE_V4 + slug;
  
  let localFilePath = path.join(BASE_DIR, pagePath + '.mdx');
  const localContent = extractMdxContent(localFilePath);
  
  if (!localContent.exists) {
    return {
      path: pagePath,
      status: 'error',
      issue: 'local_file_missing',
      details: `File not found: ${localFilePath}`
    };
  }
  
  await new Promise(resolve => setTimeout(resolve, delay));
  
  try {
    const response = await fetchUrl(sourceUrl);
    
    if (response.statusCode === 404) {
      return {
        path: pagePath,
        status: 'warning',
        issue: 'source_not_found',
        sourceUrl,
        details: 'Source page not found - may have been removed or is new content'
      };
    }
    
    if (response.statusCode !== 200) {
      return {
        path: pagePath,
        status: 'error',
        issue: 'source_error',
        sourceUrl,
        statusCode: response.statusCode
      };
    }
    
    const sourceTitle = extractTitle(response.body);
    const sourceText = extractTextContent(response.body);
    const sourceHeadings = extractSourceHeadings(response.body);
    
    const localHeadings = extractHeadings(localContent.raw);
    const similarity = contentSimilarity(localContent.content, sourceText);
    
    const issues = [];
    
    // Check title match
    if (sourceTitle && localContent.title) {
      const normalizedSource = sourceTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
      const normalizedLocal = localContent.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normalizedSource !== normalizedLocal && 
          !normalizedSource.includes(normalizedLocal) && 
          !normalizedLocal.includes(normalizedSource)) {
        issues.push({
          type: 'title_mismatch',
          local: localContent.title,
          source: sourceTitle
        });
      }
    }
    
    // Check content similarity
    if (similarity < 0.15) {
      issues.push({
        type: 'low_content_match',
        similarity: (similarity * 100).toFixed(1) + '%',
        details: 'Content may be significantly different or missing sections'
      });
    }
    
    // Check for missing major headings
    const missingHeadings = sourceHeadings.filter(sh => 
      !localHeadings.some(lh => lh.includes(sh) || sh.includes(lh))
    ).slice(0, 5);
    
    if (missingHeadings.length > 2) {
      issues.push({
        type: 'missing_sections',
        count: missingHeadings.length,
        examples: missingHeadings.slice(0, 3)
      });
    }
    
    // Check if source has substantially more content
    const sourceWordCount = sourceText.split(/\s+/).length;
    const localWordCount = localContent.content.split(/\s+/).length;
    
    if (sourceWordCount > localWordCount * 2 && sourceWordCount > 200) {
      issues.push({
        type: 'content_shorter',
        sourceWords: sourceWordCount,
        localWords: localWordCount,
        details: 'Local content may be missing significant portions'
      });
    }
    
    return {
      path: pagePath,
      status: issues.length > 0 ? 'issues' : 'ok',
      sourceUrl,
      similarity: (similarity * 100).toFixed(1) + '%',
      wordCount: { local: localWordCount, source: sourceWordCount },
      issues: issues.length > 0 ? issues : undefined
    };
    
  } catch (err) {
    return {
      path: pagePath,
      status: 'error',
      issue: 'fetch_error',
      sourceUrl,
      details: err.message
    };
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('REVERSE VERIFICATION: Local Pages vs Source Documentation');
  console.log('='.repeat(70));
  console.log('');
  
  const configPath = path.join(BASE_DIR, 'documentation.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  
  const allPaths = extractAllPaths(config.navigation);
  console.log(`Found ${allPaths.length} pages in documentation.json to verify\n`);
  
  const results = {
    ok: [],
    issues: [],
    warnings: [],
    errors: [],
    skipped: []
  };
  
  let processed = 0;
  
  for (const pageInfo of allPaths) {
    processed++;
    process.stdout.write(`\rVerifying: ${processed}/${allPaths.length} - ${pageInfo.path.substring(0, 50).padEnd(50)}...`);
    
    const result = await verifyPage(pageInfo, 250);
    
    switch (result.status) {
      case 'ok':
        results.ok.push(result);
        break;
      case 'issues':
        results.issues.push(result);
        break;
      case 'warning':
        results.warnings.push(result);
        break;
      case 'error':
        results.errors.push(result);
        break;
      case 'skipped':
        results.skipped.push(result);
        break;
    }
  }
  
  console.log('\n\n');
  console.log('='.repeat(70));
  console.log('VERIFICATION RESULTS');
  console.log('='.repeat(70));
  
  console.log(`\n✅ OK: ${results.ok.length} pages (content matches source)`);
  console.log(`⚠️  Issues: ${results.issues.length} pages (potential content differences)`);
  console.log(`🔶 Warnings: ${results.warnings.length} pages (source not found)`);
  console.log(`❌ Errors: ${results.errors.length} pages (file missing or fetch failed)`);
  console.log(`⏭️  Skipped: ${results.skipped.length} pages (API reference/changelog)`);
  
  if (results.errors.length > 0) {
    console.log('\n' + '-'.repeat(70));
    console.log('ERRORS (Missing local files or fetch failures):');
    console.log('-'.repeat(70));
    results.errors.forEach(r => {
      console.log(`\n  Path: ${r.path}`);
      console.log(`  Issue: ${r.issue}`);
      if (r.details) console.log(`  Details: ${r.details}`);
      if (r.sourceUrl) console.log(`  Source: ${r.sourceUrl}`);
    });
  }
  
  if (results.issues.length > 0) {
    console.log('\n' + '-'.repeat(70));
    console.log('CONTENT ISSUES (Review these pages):');
    console.log('-'.repeat(70));
    results.issues.forEach(r => {
      console.log(`\n  Path: ${r.path}`);
      console.log(`  Similarity: ${r.similarity}`);
      console.log(`  Word Count: Local=${r.wordCount.local}, Source=${r.wordCount.source}`);
      console.log(`  Source: ${r.sourceUrl}`);
      r.issues.forEach(issue => {
        if (issue.type === 'title_mismatch') {
          console.log(`  - Title mismatch: "${issue.local}" vs "${issue.source}"`);
        } else if (issue.type === 'low_content_match') {
          console.log(`  - Low content match: ${issue.similarity}`);
        } else if (issue.type === 'missing_sections') {
          console.log(`  - Missing ${issue.count} sections: ${issue.examples.join(', ')}`);
        } else if (issue.type === 'content_shorter') {
          console.log(`  - Content shorter: ${issue.localWords} vs ${issue.sourceWords} words`);
        }
      });
    });
  }
  
  if (results.warnings.length > 0) {
    console.log('\n' + '-'.repeat(70));
    console.log('WARNINGS (Source pages not found - may be new or renamed):');
    console.log('-'.repeat(70));
    results.warnings.forEach(r => {
      console.log(`  - ${r.path}`);
    });
  }
  
  const outputPath = path.join(__dirname, 'reverse-verification-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n\nDetailed results saved to: ${outputPath}`);
  
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  const total = allPaths.length;
  const verified = results.ok.length + results.issues.length;
  const passRate = verified > 0 ? ((results.ok.length / verified) * 100).toFixed(1) : 0;
  console.log(`Total pages in navigation: ${total}`);
  console.log(`Successfully verified: ${verified}`);
  console.log(`Pass rate: ${passRate}%`);
  console.log(`Pages needing review: ${results.issues.length}`);
  console.log('='.repeat(70));
}

main().catch(console.error);
