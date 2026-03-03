const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const BASE_DIR = path.join(__dirname, '..');
const DOCS_DIR = path.join(BASE_DIR, 'docs');
const V3_DOCS_DIR = path.join(BASE_DIR, 'v3', 'docs');

const SOURCE_BASE_V4 = 'https://docs.datafiniti.co/docs/';
const SOURCE_BASE_V3 = 'https://docs.datafiniti.co/v3/docs/';

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const request = protocol.get(url, { 
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
  return match ? match[1].trim() : null;
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
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[#*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    
    return { title, content: textContent, raw: content };
  } catch (err) {
    return { title: '', content: '', raw: '', error: err.message };
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

function similarity(str1, str2) {
  const s1 = str1.toLowerCase().substring(0, 500);
  const s2 = str2.toLowerCase().substring(0, 500);
  
  const words1 = new Set(s1.split(/\s+/).filter(w => w.length > 3));
  const words2 = new Set(s2.split(/\s+/).filter(w => w.length > 3));
  
  if (words1.size === 0 || words2.size === 0) return 0;
  
  const intersection = [...words1].filter(w => words2.has(w)).length;
  const union = new Set([...words1, ...words2]).size;
  
  return intersection / union;
}

async function verifyPage(pageInfo, delay = 500) {
  const { path: pagePath, title, isV3 } = pageInfo;
  
  if (pagePath.startsWith('reference/') || pagePath.startsWith('v3/reference/')) {
    return { path: pagePath, status: 'skipped', reason: 'API reference page' };
  }
  
  if (pagePath.includes('changelog')) {
    return { path: pagePath, status: 'skipped', reason: 'Changelog page' };
  }
  
  const slug = getSourceSlug(pagePath);
  const sourceUrl = isV3 ? SOURCE_BASE_V3 + slug : SOURCE_BASE_V4 + slug;
  
  let localFilePath;
  if (pagePath.startsWith('v3/')) {
    localFilePath = path.join(BASE_DIR, pagePath + '.mdx');
  } else if (pagePath.startsWith('docs/')) {
    localFilePath = path.join(BASE_DIR, pagePath + '.mdx');
  } else {
    localFilePath = path.join(BASE_DIR, pagePath + '.mdx');
  }
  
  const localContent = extractMdxContent(localFilePath);
  
  if (localContent.error) {
    return {
      path: pagePath,
      status: 'error',
      issue: 'local_file_missing',
      details: localContent.error
    };
  }
  
  await new Promise(resolve => setTimeout(resolve, delay));
  
  try {
    const response = await fetchUrl(sourceUrl);
    
    if (response.statusCode === 404) {
      return {
        path: pagePath,
        status: 'warning',
        issue: 'source_404',
        sourceUrl,
        details: 'Source page not found - may have been removed or renamed'
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
    
    const contentSimilarity = similarity(localContent.content, sourceText);
    
    const issues = [];
    
    if (contentSimilarity < 0.3) {
      issues.push({
        type: 'content_mismatch',
        similarity: (contentSimilarity * 100).toFixed(1) + '%',
        details: 'Content significantly differs from source'
      });
    }
    
    if (sourceTitle && localContent.title) {
      const titleMatch = sourceTitle.toLowerCase().includes(localContent.title.toLowerCase()) ||
                        localContent.title.toLowerCase().includes(sourceTitle.toLowerCase());
      if (!titleMatch && sourceTitle.toLowerCase() !== localContent.title.toLowerCase()) {
        issues.push({
          type: 'title_mismatch',
          local: localContent.title,
          source: sourceTitle
        });
      }
    }
    
    return {
      path: pagePath,
      status: issues.length > 0 ? 'issues' : 'ok',
      sourceUrl,
      similarity: (contentSimilarity * 100).toFixed(1) + '%',
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
  console.log('='.repeat(60));
  console.log('COMPREHENSIVE DOCUMENTATION VERIFICATION');
  console.log('='.repeat(60));
  console.log('');
  
  const configPath = path.join(BASE_DIR, 'documentation.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  
  const allPaths = extractAllPaths(config.navigation);
  console.log(`Found ${allPaths.length} pages to verify\n`);
  
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
    process.stdout.write(`\rVerifying: ${processed}/${allPaths.length} - ${pageInfo.path.substring(0, 50)}...`);
    
    const result = await verifyPage(pageInfo, 300);
    
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
  console.log('='.repeat(60));
  console.log('VERIFICATION RESULTS');
  console.log('='.repeat(60));
  
  console.log(`\n✅ OK: ${results.ok.length} pages`);
  console.log(`⚠️  Issues: ${results.issues.length} pages`);
  console.log(`🔶 Warnings: ${results.warnings.length} pages`);
  console.log(`❌ Errors: ${results.errors.length} pages`);
  console.log(`⏭️  Skipped: ${results.skipped.length} pages`);
  
  if (results.errors.length > 0) {
    console.log('\n' + '-'.repeat(60));
    console.log('ERRORS (Missing local files or fetch failures):');
    console.log('-'.repeat(60));
    results.errors.forEach(r => {
      console.log(`\n  Path: ${r.path}`);
      console.log(`  Issue: ${r.issue}`);
      if (r.details) console.log(`  Details: ${r.details}`);
      if (r.sourceUrl) console.log(`  Source: ${r.sourceUrl}`);
    });
  }
  
  if (results.issues.length > 0) {
    console.log('\n' + '-'.repeat(60));
    console.log('CONTENT ISSUES:');
    console.log('-'.repeat(60));
    results.issues.forEach(r => {
      console.log(`\n  Path: ${r.path}`);
      console.log(`  Similarity: ${r.similarity}`);
      console.log(`  Source: ${r.sourceUrl}`);
      r.issues.forEach(issue => {
        console.log(`  - ${issue.type}: ${issue.details || JSON.stringify(issue)}`);
      });
    });
  }
  
  if (results.warnings.length > 0) {
    console.log('\n' + '-'.repeat(60));
    console.log('WARNINGS (Source 404s - may be intentional):');
    console.log('-'.repeat(60));
    results.warnings.forEach(r => {
      console.log(`\n  Path: ${r.path}`);
      console.log(`  Source: ${r.sourceUrl}`);
      console.log(`  Details: ${r.details}`);
    });
  }
  
  const outputPath = path.join(__dirname, 'verification-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n\nDetailed results saved to: ${outputPath}`);
  
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  const total = allPaths.length;
  const verified = results.ok.length + results.issues.length;
  const passRate = ((results.ok.length / verified) * 100).toFixed(1);
  console.log(`Total pages: ${total}`);
  console.log(`Verified: ${verified}`);
  console.log(`Pass rate: ${passRate}%`);
  console.log('='.repeat(60));
}

main().catch(console.error);
