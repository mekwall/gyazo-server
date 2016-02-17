const fs = require('fs');
const cofs = require('co-fs-extra');
const path = require('path');
const shortid = require('shortid');
const mime = require('mime-types');
const readChunk = require('read-chunk');
const fileType = require('file-type');
const thunkify = require('thunkify');
const multiline = require('multiline');
const imagemin = require('imagemin');
const imageminPlugins = {
    optipng: require('imagemin-optipng'),
    pngquant: require('imagemin-pngquant'),
    svgo: require('imagemin-svgo'),
    gifsicle: require('imagemin-gifsicle'),
    mozjpeg: require('imagemin-mozjpeg')
};

const koa = require('koala');
const app = koa();
const router = require('koa-router')();

var config;
try {
    var config = require('../config');
} catch (e) {
    console.error(e);
    var config = {};
}

const tmpDir = config.tmpDir || path.join(process.cwd(), '/tmp');
const uploadsDir = config.uploadsDir || path.join(process.cwd(), '/uploads');

const isProduction = process.env.NODE_ENV === "production";

if (!fs.existsSync(tmpDir)) {
    try {
        fs.mkdirSync(tmpDir);
    } catch (e) {
        console.error("Failed to create tmpDir:", tmpDir);
    }
}

if (!fs.existsSync(uploadsDir)) {
    try {
        fs.mkdirSync(uploadsDir);
    } catch (e) {
        console.error("Failed to create tmpDir:", uploadsDir);
    }
}

app.use(function *pageNotFound(next){
    yield next;

    if (404 !== this.status) return;

    // we need to explicitly set 404 here
    // so that koa doesn't assign 200 on body=
    this.status = 404;

    switch (this.accepts('html', 'json')) {
        case 'html':
            this.type = 'html';
            this.body = '<h1>404 File Not Found</h1>';
        break;
        case 'json':
            this.body = {
                status: 404,
                message: 'File Not Found'
            };
        break;
        default:
            this.type = 'text';
            this.body = 'File Not Found';
    }
});

router.get('/', function *(next) {
    this.set('Content-Type', 'text/html');
    this.set('Last-Modified', new Date());
    this.set('Cache-Control', 'public, max-age=31556926');
    this.body = multiline.stripIndent(function(){/*
        <!doctype html>
        <html>
            <head>
                <title>Gyazo Server</title>
            </head>
            <body>
                <h1>Hi!</h1>
            </body>
        </html>
    */});
});

router.get('/upload', function *(next) {
    this.body = multiline.stripIndent(function(){/*
        <!doctype html>
        <html>
            <head>
                <title>Upload - Gyazo Server</title>
            </head>
            <body>
                <h1>Upload image</h1>
                <form action="/upload" enctype="multipart/form-data" method="post">
                <input type="file" name="imagedata"><br><br>
                <button type="submit">Upload</button>
            </body>
            <script>

                function uploadFile(file) {
                    if (!file) {
                        alert('Error! File missing');
                        return;
                    }
                    console.log('Sending file:', file);
                    var xhr = new XMLHttpRequest();

                    xhr.upload.onprogress = function(e) {
                        var percentComplete = (e.loaded / e.total) * 100;
                        console.log('Uploaded ' + percentComplete + '%');
                    };

                    xhr.onload = function() {
                        if (xhr.status == 200) {
                            alert('Sucess! Upload completed');
                            location.href = xhr.responseText;
                        } else {
                            alert('Error! Upload failed');
                        }
                    };

                    xhr.onerror = function() {
                        alert('Error! Upload failed. Could not connect to server.');
                    };

                    xhr.open('POST', '/upload', true);
                    xhr.setRequestHeader('Content-Type', file.type);
                    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
                    xhr.send(file);
                };

                document.body.addEventListener('paste', function (e) {
                    // use e.originalEvent.clipboard for newer chrome versions
                    console.log('got paste:', e);
                    var items = (e.clipboardData  || e.originalEvent.clipboardData).items;
                    console.log(JSON.stringify(items)); // will give you the mime types
                    // find pasted images among pasted items and upload them
                    for (var i = 0; i < items.length; i++) {
                        if (items[i].type.indexOf("image") === 0) {
                            uploadFile(items[i].getAsFile());
                        }
                    }
                });
            </script>
        </html>
    */});
});

/*function moveFile(source, dest, cb) {
    var readStream = fs.createReadStream(source);
    var writeStream = fs.createWriteStream(dest);
    readStream.pipe(writeStream);
    readStream.on('end', function () {
        fs.unlinkSync(source);
        cb();
    });
    readStream.on('error', function (err) {
        cb(err);
    });
}*/

function optimizeImage(source, dest, cb) {
    console.log("Optimizing file:", source);
    var buffer = readChunk.sync(source, 0, 262);
    var type = fileType(buffer);
    var optimizer = new imagemin()
        .src(source)
        .dest(path.join(tmpDir, '/opt'));

    switch (type.ext) {
        case 'png':
            optimizer.use(imageminPlugins.pngquant({
                quality: '65-80', 
                speed: 3
            }));
            optimizer.use(imageminPlugins.optipng({
                optimizationLevel: 4
            }));
        break;

        case 'jpg':
        case 'jpeg':
            optimizer.use(imageminPlugins.mozjpeg({
                quality: 80
            }));
        break;

        case 'gif':
            optimizer.use(imageminPlugins.gifsicle({
                interlaced: true
            }));
        break;

        case 'svg':
            optimizer.use(imageminPlugins.svgo()());
        break;
    }

    optimizer.run(function (err, files) {
        cofs.move(
            err ? path.join(tmpDir, '/opt', path.basename(source)) : source,
            dest
        )(cb);
    });
}

router.post('/upload', function *(next) {
    var body;
    var id = shortid.generate();
    var tmpFile = path.join(tmpDir, id);

    switch (this.request.is('json', 'urlencoded', 'multipart', 'image/*')) {
        /*case 'json':
            body = yield* this.request.json();
        break;

        case 'urlencoded':
            body = yield* this.request.urlencoded();
        break;*/

        case 'multipart':
            console.log(this.request.is());
            var parts = this.request.parts();
            var part;
            while (part = yield parts) {
                if (part.length) {
                    var key = part[0];
                    var value = part[1];
                    // check the CSRF token
                    if (key === '_csrf') {
                        this.assertCSRF(value);
                    }
                } else {
                    yield this.save(part, tmpFile);
                }
            }
            break;
        case 'image/jpeg':
        case 'image/png':
        case 'image/gif':
        case 'image/bmp':
            this.response.writeContinue();
            // a supported image, so let's download it to disk
            yield this.save(this.req, tmpFile);
            break;
        default:
            this.throw(415, 'Not Supported');
            return;
    }

    var filePath = path.join(uploadsDir, id);
    yield thunkify(optimizeImage)(tmpFile, filePath);
    console.log('Saved file', id);
    this.set('X-Gyazo-Id', id);
    this.status = 200;
    this.body = (this.request.protocol || 'http') + '://' + this.request.host + '/' + id + '.png';
    yield next;
});

router.get('image', /^\/([0-9a-zA-Z_\-]+)(?:\.jpg|\.gif|\.png|\.bmp)?$/, function *(next) {
    console.log('GET', this.params[0]);
    var file = path.join(uploadsDir, this.params[0]);
    if (yield cofs.exists(file)) {
        var buffer = readChunk.sync(file, 0, 262);
        var type = fileType(buffer);
        if (['png', 'jpg', 'bmp', 'gif', 'svg'].indexOf(type.ext) != -1) {
            this.set('Last-Modified', new Date());
            this.set('ETag', this.params[0]);
            this.set('Cache-Control', 'max-age=31556926');
            this.status = 200;
            this.type = type.mime;
            this.body = fs.createReadStream(file);
        } else {
            this.status = 500;
        }
    } else {
        this.status = 404;
    }
    yield next;
});

app.use(router.routes());

const PORT = process.env.PORT || 3131;

const appCallback = app.callback();
const server = require('http').createServer();
server.on('request', appCallback); // regular requests
server.on('checkContinue', function (req, res) {
    // requests with `Expect: 100-continue`
    req.checkContinue = true;
    fn(req, res);
});

server.listen(PORT, function (err) {
    if (err) throw err;
    console.log('Koala app listening on port %s', this.address().port);
});