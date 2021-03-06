/**
 * Created by ximing on 2019-03-15.
 */
const htmlparser = require('htmlparser2');
const path = require('path');
const fs = require('fs');
const resolve = require('resolve');

const generateCode = function(ast, code = '', distDeps, asset) {
    const { length } = ast;
    for (let i = 0; i < length; i++) {
        const node = ast[i];
        const { type, name, data, attribs, children } = node;
        if (type === 'text') {
            code += data;
        } else if (type === 'comment') {
            code += `<!-- ${data} -->`;
        } else {
            if (['include', 'wxs', 'import'].indexOf(name) >= 0 && attribs.src) {
                attribs.src = path.relative(
                    path.dirname(asset.outputFilePath),
                    distDeps[attribs.src]
                );
            }
            code += `<${name} ${Object.keys(attribs).reduce(
                (total, next) =>
                    `${total} ${attribs[next] !== '' ? `${next}="${attribs[next]}"` : next}`,
                ''
            )}`;
            if (Array.isArray(children) && children.length) {
                code += `>${generateCode(children, '', distDeps, asset)}</${name}>`;
            } else {
                code += '/>';
            }
        }
    }
    return code;
};

module.exports = class HandleWXMLDep {
    constructor() {
        this.mainPkgPathMap = {};
    }

    apply(mpb) {
        mpb.hooks.beforeEmitFile.tapPromise('HandleWXMLDep', async (asset) => {
            if (/\.wxml$/.test(asset.name)) {
                try {
                    const deps = [];
                    const distDeps = {};
                    await new Promise((resolve, reject) => {
                        const parser = new htmlparser.Parser(
                            {
                                onopentag(name, attribs) {
                                    if (name === 'import' && attribs.src) {
                                        deps.push(attribs.src);
                                    } else if (name === 'include' && attribs.src) {
                                        deps.push(attribs.src);
                                    } else if (name === 'wxs' && attribs.src) {
                                        deps.push(attribs.src);
                                    }
                                },
                                onerror(error) {
                                    reject(error);
                                },
                                onend() {
                                    resolve();
                                }
                            },
                            { decodeEntities: true }
                        );
                        parser.write(asset.contents);
                        parser.end();
                    });
                    await Promise.all(
                        deps.map((src) => {
                            let filePath = '';
                            if (src[0] === '/') {
                                filePath = path.resolve(mpb.src, `.${src}`);
                            } else if (src[0] === '.') {
                                filePath = path.resolve(asset.dir, src);
                            } else {
                                filePath = path.resolve(asset.dir, `./${src}`);
                                const { ext } = path.parse(filePath);
                                if (!fs.existsSync(filePath)) {
                                    filePath = resolve.sync(src, {
                                        basedir: mpb.cwd,
                                        extensions: [ext]
                                    });
                                }
                            }
                            const root = asset.getMeta('root');

                            let outputPath = this.mainPkgPathMap[filePath];
                            if (!outputPath) {
                                if (filePath.includes('node_modules')) {
                                    outputPath = path.join(
                                        mpb.dest,
                                        `./${root || ''}`,
                                        path
                                            .relative(mpb.cwd, filePath)
                                            .replace('node_modules', mpb.config.output.npm)
                                    );
                                } else {
                                    outputPath = path.resolve(
                                        mpb.dest,
                                        `./${root || ''}`,
                                        path.relative(mpb.src, filePath)
                                    );
                                }

                                if (!root) {
                                    this.mainPkgPathMap[filePath] = outputPath;
                                }
                            }

                            distDeps[src] = outputPath;
                            return mpb.assetManager.addAsset(filePath, outputPath, {
                                root,
                                source: asset.filePath
                            });
                        })
                    );

                    if (Object.keys(distDeps).length) {
                        const ast = htmlparser.parseDOM(asset.contents, { xmlMode: true });
                        asset.contents = generateCode(ast, '', distDeps, asset);
                    }
                } catch (e) {
                    console.error(e);
                }
            }
            return asset;
        });
    }
};
