const https = require('https');
const fs = require('fs');
const path = require('path');

const WORKSPACE = '/Users/yashwanthmuddana/Documents/work/migrations/documentationai-starter-kit';

function extractPaths(obj, paths = []) {
  if (Array.isArray(obj)) {
    obj.forEach(item => extractPaths(item, paths));
  } else if (typeof obj === 'object' && obj !== null) {
    if (obj.path && !obj.openapi) {
      paths.push(obj.path);
    }
    Object.values(obj).forEach(val => extractPaths(val, paths));
  }
  return paths;
}

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout'));
    }, 30000);
    
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timeout);
        resolve({ status: res.statusCode, data });
      });
    }).on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function normalizeContent(content) {
  return content
    .replace(/^---[\s\S]*?---/m, '')
    .replace(/\[block:[^\]]+\][\s\S]*?\[\/block\]/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' [CODE] ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s)]+/g, '')
    .replace(/[#*_~|]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

function extractListOrder(content) {
  const lines = content.split('\n');
  const listItems = [];
  
  for (const line of lines) {
    const match = line.match(/^\s*[-*]\s+\[([^\]]+)\]/);
    if (match) {
      listItems.push(match[1].toLowerCase().trim());
    }
  }
  return listItems;
}

function compareListOrder(sourceContent, localContent) {
  const sourceList = extractListOrder(sourceContent);
  const localList = extractListOrder(localContent);
  
  if (sourceList.length < 2 || localList.length < 2) {
    return { match: true, reason: 'insufficient_lists' };
  }
  
  const commonItems = sourceList.filter(item => 
    localList.some(l => l.includes(item) || item.includes(l))
  );
  
  if (commonItems.length < 2) {
    return { match: true, reason: 'no_common_items' };
  }
  
  const sourceIndices = commonItems.map(item => 
    sourceList.findIndex(s => s.includes(item) || item.includes(s))
  );
  const localIndices = commonItems.map(item => 
    localList.findIndex(l => l.includes(item) || item.includes(l))
  );
  
  let orderMatch = true;
  for (let i = 1; i < sourceIndices.length; i++) {
    const sourceOrder = sourceIndices[i] > sourceIndices[i-1];
    const localOrder = localIndices[i] > localIndices[i-1];
    if (sourceOrder !== localOrder) {
      orderMatch = false;
      break;
    }
  }
  
  return { 
    match: orderMatch,
    sourceList: commonItems.map((item, i) => `${sourceIndices[i]}:${item}`),
    localList: commonItems.map((item, i) => `${localIndices[i]}:${item}`)
  };
}

function getSourceUrl(pagePath) {
  if (pagePath.startsWith('v3/')) {
    const slug = pagePath.replace('v3/', '');
    return `https://docs.datafiniti.co/v3/${slug}.md`;
  }
  if (pagePath.startsWith('reference/')) {
    return `https://docs.datafiniti.co/reference/${pagePath.replace('reference/', '')}.md`;
  }
  if (pagePath.startsWith('changelog/')) {
    return `https://docs.datafiniti.co/changelog.md`;
  }
  return `https://docs.datafiniti.co/${pagePath}.md`;
}

async function verifyPage(pagePath) {
  const localPath = path.join(WORKSPACE, pagePath + '.mdx');
  
  if (!fs.existsSync(localPath)) {
    return { path: pagePath, status: 'missing_local', error: 'Local file not found' };
  }
  
  const localContent = fs.readFileSync(localPath, 'utf8');
  const sourceUrl = getSourceUrl(pagePath);
  
  try {
    const { status, data: sourceContent } = await fetchPage(sourceUrl);
    
    if (status === 404) {
      return { path: pagePath, status: 'source_404', url: sourceUrl };
    }
    
    if (status !== 200) {
      return { path: pagePath, status: 'fetch_error', error: `HTTP ${status}`, url: sourceUrl };
    }
    
    const normalizedSource = normalizeContent(sourceContent);
    const normalizedLocal = normalizeContent(localContent);
    
    const sourceWords = normalizedSource.split(/\s+/).filter(w => w.length > 3);
    const localWords = normalizedLocal.split(/\s+/).filter(w => w.length > 3);
    
    const commonWords = sourceWords.filter(w => localWords.includes(w));
    const similarity = Math.round((commonWords.length / Math.max(sourceWords.length, 1)) * 100);
    
    const listComparison = compareListOrder(sourceContent, localContent);
    
    const issues = [];
    if (similarity < 50) issues.push('low_similarity');
    if (!listComparison.match) issues.push('list_order_mismatch');
    
    return {
      path: pagePath,
      status: issues.length === 0 ? 'ok' : issues.join(','),
      similarity,
      listOrderMatch: listComparison.match,
      url: sourceUrl,
      details: !listComparison.match ? listComparison : undefined
    };
  } catch (err) {
    return { path: pagePath, status: 'fetch_error', error: err.message, url: sourceUrl };
  }
}

async function main() {
  const docJson = JSON.parse(fs.readFileSync(path.join(WORKSPACE, 'documentation.json'), 'utf8'));
  const paths = extractPaths(docJson.navigation);
  
  console.log(`Verifying ${paths.length} pages using .md endpoints...\n`);
  
  const results = {
    ok: [],
    issues: [],
    missing_local: [],
    source_404: [],
    fetch_error: []
  };
  
  const batchSize = 5;
  for (let i = 0; i < paths.length; i += batchSize) {
    const batch = paths.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(p => verifyPage(p)));
    
    for (const result of batchResults) {
      if (result.status === 'ok') {
        results.ok.push(result);
        console.log(`✓ ${result.path} (${result.similarity}%)`);
      } else if (result.status === 'missing_local') {
        results.missing_local.push(result);
        console.log(`✗ ${result.path} - MISSING LOCAL FILE`);
      } else if (result.status === 'source_404') {
        results.source_404.push(result);
        console.log(`? ${result.path} - SOURCE 404`);
      } else if (result.status === 'fetch_error') {
        results.fetch_error.push(result);
        console.log(`! ${result.path} - ${result.error}`);
      } else {
        results.issues.push(result);
        console.log(`⚠ ${result.path} (${result.similarity}%) - ${result.status}`);
      }
    }
    
    await new Promise(r => setTimeout(r, 300));
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`✓ OK: ${results.ok.length}`);
  console.log(`⚠ Issues: ${results.issues.length}`);
  console.log(`✗ Missing Local: ${results.missing_local.length}`);
  console.log(`? Source 404: ${results.source_404.length}`);
  console.log(`! Fetch Error: ${results.fetch_error.length}`);
  
  if (results.issues.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('PAGES WITH ISSUES');
    console.log('='.repeat(60));
    results.issues.forEach(r => {
      console.log(`\n${r.path}:`);
      console.log(`  Status: ${r.status}`);
      console.log(`  Similarity: ${r.similarity}%`);
      if (r.details) {
        console.log(`  Source order: ${r.details.sourceList?.join(', ')}`);
        console.log(`  Local order: ${r.details.localList?.join(', ')}`);
      }
    });
  }
  
  if (results.missing_local.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('MISSING LOCAL FILES');
    console.log('='.repeat(60));
    results.missing_local.forEach(r => console.log(`  ${r.path}`));
  }
  
  if (results.source_404.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('SOURCE 404 (may be renamed or removed)');
    console.log('='.repeat(60));
    results.source_404.forEach(r => console.log(`  ${r.path} -> ${r.url}`));
  }
  
  fs.writeFileSync(
    path.join(WORKSPACE, 'verification-results.json'),
    JSON.stringify(results, null, 2)
  );
  console.log('\nResults saved to verification-results.json');
}

main().catch(console.error);
