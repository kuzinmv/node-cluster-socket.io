var cluster = require('cluster');
var net = require('net');
var urlHelper = require('url');
var qs = require('querystring');

var sio = require('socket.io');
var express = require('express');

var port = 9001;
var num_processes = require('os').cpus().length;

if (cluster.isMaster) {
    var workers = [];

    for (var i = 0; i < num_processes; i++) {
        workers[i] = cluster.fork();
    }

    // Create the outside facing server listening on our port.
    var server = net.createServer({ pauseOnConnect: true }, function(socket) {

        socket.on('readable', function () {
            var buffer = socket.read();
            if (!buffer) {
                return
            }
            var headers = buffer.toString();
            var to = headers.indexOf('HTTP');

            // Quick & dirty way to get query string params
            console.log(headers.substr(0, to));
            var url = headers.substr(0, to).replace('GET /','http://').replace('POST /', 'http://');
            var queryParams = qs.parse(urlHelper.parse(url).query);

            var index = queryParams.userId % num_processes;
            var worker = workers[index];

            worker.send({
                type:'sticky-session:connection',
                buffer: buffer.toString()
            }, socket);
        });

    }).listen(port);

} else {
    // Group sockets on userId
    var sessions = [];

    // Note we don't use a port here because the master listens on it for us.
    // Here you might use middleware, attach routes, etc.
    // Don't expose our internal server to the outside.
    var app = new express();
    var server = app.listen(0, 'localhost');
    var io = sio(server);

    // Here you might use Socket.IO middleware for authorization etc.

    io.use(function(socket, next) {
        var userId = socket.handshake.query.userId;
        // make sure the handshake data looks good as before
        // if error do this:
        // next(new Error('not authorized'));
        // else just call next
        if (sessions.hasOwnProperty(userId)) {
            if (sessions[userId].length >= 5) {
                next(new Error('Too many sessions per one account'));
                return;
            }
            sessions[userId].push(socket);
        } else {
            sessions[userId] = [socket];
        }
        next();
    });

    io.sockets.on('connection', function (socket) {
        var userId = socket.handshake.query.userId;
        socket.emit('this', 'Hello [' + userId + ']!');
        console.log(process.pid + ': I received connect from ', userId, ' and say hello!');

        socket.on('request', function (userId, data) {
            console.log(process.pid + ': I received request from ', userId, ' saying ', data);
            if (! sessions.hasOwnProperty(userId)) {
                return;
            }
            sessions[userId].forEach(function(v,i){
                v.emit('response', data);
            })

        });

        socket.on('disconnect', function () {
            var login = socket.handshake.query.userId;
            if (! sessions.hasOwnProperty(userId)) {
                return;
            }
            var i = sessions[userId].indexOf(socket);
            if (i != -1) {
                sessions[userId].splice(i, 1);
            }
            console.log(process.pid + ': The user: '+ userId + ' disconnected ('+socket.id+')');
        });

    });

    // Listen to messages sent from the master. Ignore everything else.
    process.on('message', function(message, socket) {
        if (message.type !== 'sticky-session:connection') {
            return;
        }

        // Emulate a connection event on the server by emitting the
        // event with the connection the master sent us.

        server.emit('connection', socket);

        // Call data event for socket with first chunk of client request
        var buffer = Buffer.from(message.buffer);
        socket.emit('data', buffer);
        socket.resume();


    });
}