const fs = require('fs');
const path = require('path');

class ImageAltImprover {
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    this.fixedCount = 0;
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

  getPageTitle(content) {
    const titleMatch = content.match(/^---[\s\S]*?title:\s*["']?([^"'\n]+)["']?[\s\S]*?---/m);
    return titleMatch ? titleMatch[1].trim() : null;
  }

  getNearestHeading(content, imageIndex) {
    const beforeImage = content.substring(0, imageIndex);
    const headingMatches = [...beforeImage.matchAll(/^#{1,4}\s+(.+)$/gm)];
    
    if (headingMatches.length > 0) {
      const lastHeading = headingMatches[headingMatches.length - 1][1];
      return lastHeading.replace(/[*_`]/g, '').trim();
    }
    return null;
  }

  generateContextualAlt(content, imageIndex, pageTitle, filePath) {
    const nearestHeading = this.getNearestHeading(content, imageIndex);
    
    if (nearestHeading) {
      return `Screenshot showing ${nearestHeading.toLowerCase()}`;
    }
    
    if (pageTitle) {
      return `Screenshot from ${pageTitle}`;
    }
    
    const pageName = path.basename(filePath, '.mdx')
      .replace(/[-_]/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2');
    
    return `Screenshot from ${pageName}`;
  }

  isGenericAlt(alt) {
    if (!alt || alt === '') return true;
    if (/^[a-f0-9]{6,}\s*image$/i.test(alt)) return true;
    if (/^[a-f0-9]{6,}$/i.test(alt)) return true;
    if (/^image$/i.test(alt)) return true;
    return false;
  }

  fixFile(filePath) {
    let content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(this.workspaceRoot, filePath);
    const pageTitle = this.getPageTitle(content);
    let modified = false;
    let fileFixCount = 0;

    const imageRegex = /<Image\s+([^>]*?)(\s*\/?>)/g;
    let match;
    const replacements = [];

    while ((match = imageRegex.exec(content)) !== null) {
      const fullMatch = match[0];
      const attrs = match[1];
      const closing = match[2];
      const imageIndex = match.index;
      
      const altMatch = attrs.match(/alt=["']([^"']*)["']/);
      const currentAlt = altMatch ? altMatch[1] : '';

      if (this.isGenericAlt(currentAlt)) {
        const newAlt = this.generateContextualAlt(content, imageIndex, pageTitle, relativePath);
        
        let newAttrs;
        if (altMatch) {
          newAttrs = attrs.replace(/alt=["'][^"']*["']/, `alt="${newAlt}"`);
        } else {
          newAttrs = `${attrs} alt="${newAlt}"`;
        }
        
        replacements.push({
          original: fullMatch,
          replacement: `<Image ${newAttrs}${closing}`,
          index: imageIndex
        });
        fileFixCount++;
      }
    }

    for (let i = replacements.length - 1; i >= 0; i--) {
      const r = replacements[i];
      content = content.substring(0, r.index) + r.replacement + content.substring(r.index + r.original.length);
      modified = true;
    }

    if (modified) {
      fs.writeFileSync(filePath, content);
      this.fixedCount += fileFixCount;
      console.log(`  Improved ${fileFixCount} images in ${relativePath}`);
    }

    return fileFixCount;
  }

  fixAll() {
    const files = this.getAllMdxFiles();
    console.log(`Scanning ${files.length} MDX files for images with generic alt text...\n`);
    
    let filesFixed = 0;
    
    for (const file of files) {
      const count = this.fixFile(file);
      if (count > 0) filesFixed++;
    }

    return {
      filesFixed,
      imagesFixed: this.fixedCount
    };
  }
}

async function main() {
  const workspaceRoot = path.resolve(__dirname, '..');
  const fixer = new ImageAltImprover(workspaceRoot);

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           Image Alt Text Improver                          ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const { filesFixed, imagesFixed } = fixer.fixAll();

  console.log('\n' + '═'.repeat(60));
  console.log(`Improved ${imagesFixed} images in ${filesFixed} files`);
  console.log('═'.repeat(60));

  return { filesFixed, imagesFixed };
}

module.exports = { ImageAltImprover, main };

if (require.main === module) {
  main().catch(console.error);
}
