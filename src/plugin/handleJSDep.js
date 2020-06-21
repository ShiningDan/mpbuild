/**
 * Created by ximing on 2019-03-15.
 */
const path = require('path');
const babylon = require('@babel/parser');
const t = require('@babel/types');
const babelTraverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const template = require('@babel/template').default;
const bresolve = require('browser-resolve');
const resolve = require('resolve');
const fs = require('fs');
const { rewriteNpm } = require('../util');

module.exports = class HandleJSDep {
    constructor() {
        this.name = 'HandleJSDep';
        this.mainPkgPathMap = {};
    }

    // findJSFile(dir, lib) {
    //     let libPath = '';
    //     // TODO 更好的办法  case index.service
    //     if (['.js', '.ts', '.jsx', '.tsx', '.wxs'].includes(path.extname(lib))) {
    //         libPath = resolve.sync(path.join(dir, `${lib}`));
    //     } else {
    //         for (let i = 0, l = this.mpb.config.resolve.extensions.length; i < l; i++) {
    //             const ext = this.mpb.config.resolve.extensions[i];
    //             try {
    //                 // console.log('->', path.join(dir, `${lib}${ext}`));
    //                 libPath = resolve.sync(path.join(dir, `${lib}${ext}`));
    //                 if (libPath) break;
    //             } catch (e) {
    //                 try {
    //                     // console.log('----->', path.join(dir, lib, `index${ext}`));
    //                     libPath = resolve.sync(path.join(dir, lib, `index${ext}`));
    //                     if (libPath) break;
    //                 } catch (e) {
    //                     // console.log(e);
    //                 }
    //             }
    //         }
    //         if (!libPath) {
    //             throw new Error(`找不到${dir}${lib}`);
    //         }
    //     }
    //     return libPath;
    // }

    // @TODO: 是否open出去，到配置上
    // aliasLibName(lib) {
    //     if (lib === 'react-dom') {
    //         return '@r2m/runtime';
    //     }
    //     return lib;
    // }

    apply(mpb) {
        this.mpb = mpb;
        const exts = mpb.extensions.es.filter((item) => item !== '.json');
        mpb.hooks.beforeEmitFile.tapPromise('HandleJSDep', async (asset) => {
            const deps = [];
            try {
                console.log(mpb.extensions.es, asset.ext);
                if (exts.includes(asset.ext) && asset.contents) {
                    // if (/\.(js|jsx|wxs|ts|tsx)$/.test(asset.outputFilePath) && asset.contents) {
                    const code = asset.contents;
                    const ast = babylon.parse(code, { sourceType: 'module' });
                    babelTraverse(ast, {
                        Expression: {
                            enter: (astPath) => {
                                const { node, parent } = astPath;
                                if (
                                    node.type === 'CallExpression' &&
                                    node.callee.name === 'require'
                                ) {
                                    if (
                                        node.arguments &&
                                        node.arguments.length === 1 &&
                                        t.isStringLiteral(node.arguments[0])
                                    ) {
                                        const { imported: lib } = mpb.hooks.beforeResolve.call({
                                            imported: node.arguments[0].value,
                                            asset,
                                            resolveType: 'es'
                                        }) || { lib: node.arguments[0].value };
                                        const { imported: libPath } = mpb.hooks.resolve.call({
                                            imported: lib,
                                            asset,
                                            resolveType: 'es'
                                        });
                                        const root = asset.getMeta('root');
                                        const isNPM = libPath.includes('node_modules');
                                        let libOutputPath = this.mainPkgPathMap[libPath];
                                        if (!libOutputPath) {
                                            if (isNPM) {
                                                libOutputPath = rewriteNpm(libPath, root, mpb.dest);
                                            } else {
                                                libOutputPath = path.join(
                                                    mpb.dest,
                                                    `./${root || ''}`,
                                                    path.relative(mpb.src, libPath)
                                                );
                                            }

                                            if (!root) {
                                                this.mainPkgPathMap[libPath] = libOutputPath;
                                            }
                                        }

                                        // TODO How to handle renamed files more gracefully
                                        if (
                                            libOutputPath.endsWith('.ts') ||
                                            libOutputPath.endsWith('.jsx') ||
                                            libOutputPath.endsWith('.tsx')
                                        ) {
                                            const [
                                                libOutputPathPrefix,
                                                ext
                                            ] = mpb.helper.splitExtension(libOutputPath);
                                            libOutputPath = `${libOutputPathPrefix}.${
                                                ext === 'wxs' ? ext : 'js'
                                            }`;
                                        }
                                        // JSON 被直接替换
                                        if (libOutputPath.endsWith('.json')) {
                                            // const [libOutputPathPrefix] = mpb.helper.splitExtension(
                                            //     libOutputPath
                                            // );
                                            // libOutputPath = `${libOutputPathPrefix}.js`;
                                            parent.right = template.ast(
                                                `(${fs.readFileSync(libPath, 'utf-8')})`
                                            );
                                        } else {
                                            const {
                                                importedDest: destPath
                                            } = mpb.hooks.reWriteImported.call({
                                                importedSrc: libPath,
                                                importedDest: libOutputPath,
                                                asset,
                                                resolveType: 'es'
                                            });
                                            node.arguments[0].value = destPath;
                                            // node.arguments[0].value = path.relative(
                                            //     path.parse(asset.outputFilePath).dir,
                                            //     libOutputPath
                                            // );
                                            // if (node.arguments[0].value[0] !== '.') {
                                            //     node.arguments[0].value = `./${node.arguments[0].value}`;
                                            // }
                                            deps.push({
                                                libPath,
                                                libOutputPath
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    });
                    const [outputPrefix, ext] = mpb.helper.splitExtension(asset.outputFilePath);
                    asset.outputFilePath = `${outputPrefix}.${ext === 'wxs' ? ext : 'js'}`;
                    asset.contents = generate(ast, {
                        quotes: 'single',
                        retainLines: true
                    }).code;
                }
            } catch (e) {
                console.error('[handleJSDep parse error]', e, asset.path);
            }
            if (deps.length) {
                try {
                    // console.log('before', asset.path);
                    for (let i = 0, l = deps.length; i < l; i++) {
                        const { libPath, libOutputPath } = deps[i];
                        const root = asset.getMeta('root');
                        await mpb.assetManager.addAsset(libPath, libOutputPath, {
                            root,
                            source: asset.filePath
                        });
                    }
                    // await Promise.all(
                    //     deps.map((dep) => {
                    //         const { libPath, libOutputPath } = dep;
                    //         const root = asset.getMeta('root');
                    //         return mpb.assetManager.addAsset(libPath, libOutputPath, {
                    //             root,
                    //             source: asset.filePath
                    //         });
                    //     })
                    // );
                    // console.log('after deps', asset.path);
                } catch (e) {
                    console.error('[handleJSDep]', e);
                }
            }
            return asset;
        });
    }
};
