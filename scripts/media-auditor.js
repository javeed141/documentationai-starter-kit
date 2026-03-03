const fs = require('fs');
const path = require('path');

class MediaAuditor {
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    this.issues = [];
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

  parseAttributes(attrString) {
    const attrs = {};
    const attrRegex = /(\w+(?:-\w+)*)(?:=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}))?/g;
    let match;
    
    while ((match = attrRegex.exec(attrString)) !== null) {
      const [, name, doubleQuoted, singleQuoted, jsxValue] = match;
      attrs[name] = doubleQuoted ?? singleQuoted ?? jsxValue ?? true;
    }
    
    return attrs;
  }

  auditImages(content, filePath) {
    const issues = [];
    const lines = content.split('\n');
    const imageRegex = /<Image\s+([^>]*?)\/?\s*>/g;
    
    let lineNum = 0;
    for (const line of lines) {
      lineNum++;
      let match;
      
      while ((match = imageRegex.exec(line)) !== null) {
        const attrs = this.parseAttributes(match[1]);
        const imageIssues = [];
        
        if (!attrs.src) {
          imageIssues.push('missing src');
        }
        
        if (!attrs.width) {
          imageIssues.push('missing width');
        }
        
        if (!attrs.height) {
          imageIssues.push('missing height');
        }
        
        if (!attrs.alt) {
          imageIssues.push('missing alt');
        }

        if (attrs.width && isNaN(parseInt(attrs.width))) {
          imageIssues.push(`invalid width: ${attrs.width}`);
        }
        
        if (attrs.height && isNaN(parseInt(attrs.height))) {
          imageIssues.push(`invalid height: ${attrs.height}`);
        }

        if (imageIssues.length > 0) {
          issues.push({
            type: 'Image',
            line: lineNum,
            filePath,
            issues: imageIssues,
            src: attrs.src || 'unknown',
            width: attrs.width,
            height: attrs.height,
            alt: attrs.alt
          });
        }
      }
    }
    
    return issues;
  }

  auditIframes(content, filePath) {
    const issues = [];
    const lines = content.split('\n');
    const iframeRegex = /<Iframe\s+([^>]*?)\/?\s*>/g;
    
    let lineNum = 0;
    for (const line of lines) {
      lineNum++;
      let match;
      
      while ((match = iframeRegex.exec(line)) !== null) {
        const attrs = this.parseAttributes(match[1]);
        const iframeIssues = [];
        
        if (!attrs.src) {
          iframeIssues.push('missing src');
        }
        
        if (!attrs.width) {
          iframeIssues.push('missing width');
        }
        
        if (!attrs.height) {
          iframeIssues.push('missing height');
        }

        if (iframeIssues.length > 0) {
          issues.push({
            type: 'Iframe',
            line: lineNum,
            filePath,
            issues: iframeIssues,
            src: attrs.src || 'unknown',
            width: attrs.width,
            height: attrs.height
          });
        }
      }
    }
    
    return issues;
  }

  auditVideos(content, filePath) {
    const issues = [];
    const lines = content.split('\n');
    const videoRegex = /<Video\s+([^>]*?)\/?\s*>/g;
    
    let lineNum = 0;
    for (const line of lines) {
      lineNum++;
      let match;
      
      while ((match = videoRegex.exec(line)) !== null) {
        const attrs = this.parseAttributes(match[1]);
        const videoIssues = [];
        
        if (!attrs.src) {
          videoIssues.push('missing src');
        }
        
        if (!attrs.width) {
          videoIssues.push('missing width');
        }
        
        if (!attrs.height) {
          videoIssues.push('missing height');
        }

        if (videoIssues.length > 0) {
          issues.push({
            type: 'Video',
            line: lineNum,
            filePath,
            issues: videoIssues,
            src: attrs.src || 'unknown',
            width: attrs.width,
            height: attrs.height
          });
        }
      }
    }
    
    return issues;
  }

  auditFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(this.workspaceRoot, filePath);
    const issues = [];

    issues.push(...this.auditImages(content, relativePath));
    issues.push(...this.auditIframes(content, relativePath));
    issues.push(...this.auditVideos(content, relativePath));

    return issues;
  }

  auditAll() {
    const files = this.getAllMdxFiles();
    const allIssues = [];
    const stats = {
      totalFiles: files.length,
      filesWithIssues: 0,
      images: { total: 0, withIssues: 0 },
      iframes: { total: 0, withIssues: 0 },
      videos: { total: 0, withIssues: 0 }
    };

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      const relativePath = path.relative(this.workspaceRoot, file);
      
      const imageCount = (content.match(/<Image\s/g) || []).length;
      const iframeCount = (content.match(/<Iframe\s/g) || []).length;
      const videoCount = (content.match(/<Video\s/g) || []).length;
      
      stats.images.total += imageCount;
      stats.iframes.total += iframeCount;
      stats.videos.total += videoCount;

      const issues = this.auditFile(file);
      
      if (issues.length > 0) {
        stats.filesWithIssues++;
        allIssues.push(...issues);
        
        for (const issue of issues) {
          if (issue.type === 'Image') stats.images.withIssues++;
          if (issue.type === 'Iframe') stats.iframes.withIssues++;
          if (issue.type === 'Video') stats.videos.withIssues++;
        }
      }
    }

    return { stats, issues: allIssues };
  }
}

async function main() {
  const workspaceRoot = path.resolve(__dirname, '..');
  const auditor = new MediaAuditor(workspaceRoot);

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         Media Auditor - Images, Iframes, Videos            ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const { stats, issues } = auditor.auditAll();

  console.log('Media Statistics:');
  console.log(`  Total files scanned: ${stats.totalFiles}`);
  console.log(`  Files with issues: ${stats.filesWithIssues}`);
  console.log('');
  console.log(`  Images: ${stats.images.total} total, ${stats.images.withIssues} with issues`);
  console.log(`  Iframes: ${stats.iframes.total} total, ${stats.iframes.withIssues} with issues`);
  console.log(`  Videos: ${stats.videos.total} total, ${stats.videos.withIssues} with issues`);

  if (issues.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log('ISSUES FOUND:');
    console.log('─'.repeat(60));

    const byFile = {};
    for (const issue of issues) {
      if (!byFile[issue.filePath]) byFile[issue.filePath] = [];
      byFile[issue.filePath].push(issue);
    }

    for (const [file, fileIssues] of Object.entries(byFile)) {
      console.log(`\n${file}:`);
      for (const issue of fileIssues) {
        console.log(`  Line ${issue.line} [${issue.type}]: ${issue.issues.join(', ')}`);
        if (issue.src && issue.src !== 'unknown') {
          console.log(`    src: ${issue.src.substring(0, 60)}${issue.src.length > 60 ? '...' : ''}`);
        }
      }
    }
  }

  const outputPath = path.join(__dirname, 'media-audit-results.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    stats,
    issues
  }, null, 2));

  console.log(`\nResults saved to: ${outputPath}`);

  return { stats, issues };
}

module.exports = { MediaAuditor, main };

if (require.main === module) {
  main().catch(console.error);
}
