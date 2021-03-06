var ConnectionPool = require('../../src/lib/connection_pool');
var Host = require('../../src/lib/host');
var errors = require('../../src/lib/errors');
var ConnectionAbstract = require('../../src/lib/connection');
var _ = require('lodash');
var EventEmitter = require('events').EventEmitter;
var should = require('should');
var sinon = require('sinon');
var stub = require('./auto_release_stub').make();

function listenerCount(emitter, event) {
  if (EventEmitter.listenerCount) {
    // newer node
    return EventEmitter.listenerCount(emitter, event);
  } else {
    // older node
    return emitter.listeners(event).length;
  }
}

describe('Connection Pool', function () {
  describe('Adding/Removing/Syncing Connections', function () {
    var pool, host, connection, host2, connection2;

    beforeEach(function () {
      pool = new ConnectionPool({});

      host = new Host({
        port: 999
      });
      connection = new ConnectionAbstract(host);

      host2 = new Host({
        port: 2222
      });
      connection2 = new ConnectionAbstract(host2);
    });

    it('#addConnection only adds the connection if it doesn\'t already exist', function () {
      _.keys(pool.index).length.should.eql(0);
      pool.addConnection(connection);

      _.keys(pool.index).should.eql([host.toString()]);

      pool._conns.alive.should.eql([connection]);
      pool._conns.dead.should.eql([]);
    });

    describe('#removeConnection', function () {
      it('removes the connection if it exist', function () {
        pool.addConnection(connection);
        pool.removeConnection(connection2);

        pool._conns.alive.should.eql([connection]);
        pool._conns.dead.should.eql([]);
        _.keys(pool.index).length.should.eql(1);
      });

      it('closes the connection when it removes it', function () {
        pool.addConnection(connection);
        connection.status.should.eql('alive');
        listenerCount(connection, 'status set').should.eql(1);

        pool.removeConnection(connection);

        connection.status.should.eql('closed');
        listenerCount(connection, 'status set').should.eql(0);
      });
    });

    it('#setHosts syncs the list of Hosts with the connections in the index', function () {
      // there should now be two connections
      pool.setHosts([host, host2]);
      pool._conns.alive.length.should.eql(2);
      pool._conns.dead.length.should.eql(0);

      // get the new connections
      connection = pool.index[host.toString()];
      connection2 = pool.index[host2.toString()];

      // should remove the second connection
      pool.setHosts([host]);
      pool._conns.alive.should.eql([connection]);
      pool._conns.dead.length.should.eql(0);

      // should skip the first, but create a new for the second
      pool.setHosts([host, host2]);
      pool._conns.alive.length.should.eql(2);
      pool._conns.dead.length.should.eql(0);

      // a new connection should have been created
      pool.index[host2.toString()].should.not.be.exactly(connection2);
    });
  });

  describe('Connection selection', function () {
    var pool, host, host2;

    beforeEach(function () {
      pool = new ConnectionPool({});

      host = new Host('localhost:9200');
      host2 = new Host('localhost:9201');

      pool.setHosts([
        host,
        host2
      ]);
    });

    it('detects if the selector is async', function (done) {
      pool.selector = function (list, cb) {
        cb.should.have.type('function');
        cb();
      };

      pool.select(function (err) {
        if (err) { throw err; }
        done();
      });
    });

    it('detects if the selector is not async', function (done) {
      pool.selector = function (list) {
        arguments.should.have.length(1);
      };

      pool.select(function (err) {
        if (err) { throw err; }
        done();
      });
    });

    it('sync selectors should still return async', function (done) {
      pool.selector = function (list) {
        return list[0];
      };

      var selected = null;

      pool.select(function (err, selection) {
        if (err) { throw err; }
        selection.host.should.be.exactly(host);
        selected = selection;
        done();
      });

      should(selected).be.exactly(null);
    });

    it('should catch errors in sync selectors', function (done) {
      pool.selector = function (list) {
        return JSON.notAMethod();
      };

      pool.select(function (err, selection) {
        should(err).be.an.instanceOf(Error);
        done();
      });
    });

  });

  describe('Connection selection with no living nodes', function () {
    it('should ping all of the dead nodes, in order of oldest timeout, and return the first that\'s okay',
    function (done) {
      var clock = sinon.useFakeTimers('setTimeout', 'clearTimeout');
      var pool = new ConnectionPool({
        deadTimeout: 10000
      });

      var connections = [
        new ConnectionAbstract(new Host('http://localhost:9200')),
        new ConnectionAbstract(new Host('http://localhost:9201')),
        new ConnectionAbstract(new Host('http://localhost:9202')),
        new ConnectionAbstract(new Host('http://localhost:9203'))
      ];
      var pingQueue = _.shuffle(connections);
      var expectedSelection = pingQueue[pingQueue.length - 1];

      pingQueue.forEach(function (conn) {
        pool.addConnection(conn);
        stub(conn, 'ping', function (params, cb) {
          if (typeof params === 'function') {
            cb = params;
          }
          var expectedConn = pingQueue.shift();
          conn.should.be.exactly(expectedConn);
          if (pingQueue.length) {
            process.nextTick(function () {
              cb(new Error('keep trying'));
            });
          } else {
            process.nextTick(function () {
              cb(null, true);
            });
          }
        });
        conn.setStatus('dead');
        clock.tick(500);
      });

      pool.select(function (err, selection) {
        clock.restore();
        selection.should.be.exactly(expectedSelection);
        pingQueue.should.have.length(0);
        pool.setHosts([]);
        should.not.exist(err);
        done();
      });
    });
  });

  describe('Connection state management', function () {
    var pool, host, host2, connection, connection2;

    beforeEach(function () {
      pool = new ConnectionPool({});

      host = new Host('localhost:9200');
      host2 = new Host('localhost:9201');

      pool.setHosts([
        host,
        host2
      ]);

      connection = pool.index[host.toString()];
      connection2 = pool.index[host2.toString()];

      pool._conns.alive.should.have.length(2);
      pool._conns.dead.should.have.length(0);
    });

    afterEach(function () {
      pool.close();
    });

    it('moves an alive connection to dead', function () {
      connection.setStatus('dead');

      pool._conns.alive.should.have.length(1);
      pool._conns.dead.should.have.length(1);
    });

    it('clears and resets the timeout when a connection redies', function () {
      var clock = sinon.useFakeTimers('setTimeout', 'clearTimeout');

      connection.setStatus('dead');
      _.size(clock.timeouts).should.eql(1);
      var id = _(clock.timeouts).keys().first();

      // it re-dies
      connection.setStatus('dead');
      _.size(clock.timeouts).should.eql(1);
      _(clock.timeouts).keys().first().should.not.eql(id);
      clock.restore();
    });

    it('does nothing when a connection is re-alive', function () {
      var last = pool._conns.alive[pool._conns.alive.length - 1];
      var first = pool._conns.alive[0];

      last.should.not.be.exactly(first);

      // first re-alives
      first.setStatus('alive');
      pool._conns.alive[0].should.be.exactly(first);
      pool._conns.alive[pool._conns.alive.length - 1].should.be.exactly(last);

      // last re-alives
      last.setStatus('alive');
      pool._conns.alive[0].should.be.exactly(first);
      pool._conns.alive[pool._conns.alive.length - 1].should.be.exactly(last);
    });

    it('removes all its connection when it closes, causing them to be closed', function () {
      pool.close();
      pool._conns.alive.should.have.length(0);
      pool._conns.dead.should.have.length(0);

      connection.status.should.eql('closed');
      connection2.status.should.eql('closed');
    });

  });

  describe('#getConnections', function () {
    it('will return all values from the alive list by default', function () {
      var pool = new ConnectionPool({});
      pool._conns.alive = new Array(1000);
      var length = pool._conns.alive.length;
      while (length--) {
        pool._conns.alive[length] = length;
      }

      var result = pool.getConnections();
      result.should.have.length(1000);
      _.reduce(result, function (sum, num) {
        return sum += num;
      }, 0).should.eql(499500);
    });
  });

  describe('#calcDeadTimeout', function () {
    it('should be configurable via config.calcDeadTimeout', function () {
      var pool = new ConnectionPool({
        calcDeadTimeout: 'flat'
      });
      pool.calcDeadTimeout.should.be.exactly(ConnectionPool.calcDeadTimeoutOptions.flat);
      pool.close();
    });
    it('"flat" always returns the base timeout', function () {
      var pool = new ConnectionPool({
        calcDeadTimeout: 'flat'
      });
      pool.calcDeadTimeout(0, 1000).should.eql(1000);
      pool.calcDeadTimeout(10, 5000).should.eql(5000);
      pool.calcDeadTimeout(25, 10000).should.eql(10000);
    });
    it('"exponential" always increases the timeout based on the attempts', function () {
      var pool = new ConnectionPool({
        calcDeadTimeout: 'exponential'
      });
      pool.calcDeadTimeout(0, 1000).should.eql(1000);
      pool.calcDeadTimeout(10, 5000).should.be.above(5000);
      pool.calcDeadTimeout(25, 10000).should.be.above(10000);
    });
    it('"exponential" produces predicatable results', function () {
      var pool = new ConnectionPool({
        calcDeadTimeout: 'exponential'
      });
      pool.calcDeadTimeout(0, 1000).should.eql(1000);
      pool.calcDeadTimeout(4, 10000).should.eql(40000);
      // maxes out at 30 minutes by default
      pool.calcDeadTimeout(25, 30000).should.eql(18e5);
    });
    it('"exponential" repects config.maxDeadtimeout', function () {
      var pool = new ConnectionPool({
        calcDeadTimeout: 'exponential',
        maxDeadTimeout: 10000
      });
      pool.calcDeadTimeout(0, 1000).should.eql(1000);
      pool.calcDeadTimeout(10, 1000).should.eql(10000);
      pool.calcDeadTimeout(100, 1000).should.eql(10000);
    });
  });
});
