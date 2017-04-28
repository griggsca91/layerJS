'use strict';

var Kern = require('../kern/Kern.js');
var layerJS = require('./layerjs.js');
var $ = require('./domhelpers.js');

/**
 *  class that will contain the state off all the stages, layers, frames
 *
 * @extends Kern.EventManager
 */
var State = Kern.EventManager.extend({
  constructor: function(doc) {
    this.document = doc || document;
    this.document._ljState = this;
    this.viewTypes = ['stage', 'layer', 'frame'];
    this.views = {}; // contains view and path; indexed by id
    this.layers = []; // list of all layers (ids)
    this.paths = {}; // lookup by path (and all path endings) for all ids
    this._transitionGroupId = 0;
    this._transitionGroup = {};

    Kern.EventManager.call(this);
    this.previousState = [];
  },
  /**
   * Will register a View with the state
   * @param {object} a layerJSView
   */
  registerView: function(view) {
    // only add to state structure if the frame is really shown (attached to DOM)
    if (view.document.body.contains(view.outerEl)) {
      var id = view.id();
      if (this.views[id]) {
        if (this.views[id].view !== view) throw "state.registerView: duplicate HTML id '" + id + "'";
        return; // already registered;
      }
      var path = this.buildPath(view.outerEl); // get full path of view
      this.views[id] = {
        view: view,
        path: path
      };
      var that = this;
      this.getTrailingPaths(path).forEach(function(tp) { // add paths index for all path endings
        (that.paths[tp] = that.paths[tp] || []).push(id);
      });
      if (view.type() === 'layer') this.layers.push(id);
      view.on('childAdded', function(child) {
        that.registerView(child);
      }, {
        context: this
      });
      view.on('childRemoved', function(child) {
        that.unregisterView(child);
      }, {
        context: this
      });
      view.on('transitionStarted', function(frameName, transition) {
        var trigger = true;
        // when a transitiongroup is defined, only call stateChanged when all layers in group have invoked 'transitionStarted'
        if (transition && transition.hasOwnProperty('groupId') && this._transitionGroup.hasOwnProperty(transition.groupId)) {
          this._transitionGroup[transition.groupId]--;
          trigger = this._transitionGroup[transition.groupId] === 0;
        }
        if (trigger) {
          // check if the state really changed
          trigger = false;
          var state = this.exportState(true);
          if (this.previousState) {
            if (this.previousState.length !== state.length) {
              trigger = true; // state has changed
            } else {
              for (var i = 0; i < this.previousState.length; i++) {
                if (this.previousState[i] !== state[i]) {
                  trigger = true; // state has changed
                  break;
                }
              }
            }
          }

          if (trigger) {
            // trigger the event and keep a copy of the new state to compare it to next time
            this.previousState = state;
            this.trigger("stateChanged", state);
          }
        }
      }, {
        context: this
      });
      view.on('attributesChanged', this._attributesChangedEvent(view), {
        context: this
      });
    }
  },
  /**
   * unregisters a view
   *
   * @param {Type} Name - Description
   * @returns {Type} Description
   */
  unregisterView: function(view) {
    var i,
      id = view.id(),
      that = this;
    this.getTrailingPaths(this.views[id].path).forEach(function(tp) {
      var i = that.paths[tp].indexOf(id);
      that.paths[tp].splice(i, 1);
      if (that.paths[tp].length === 0) delete that.paths[tp];
    });
    if (view.type() === 'layer') {
      i = this.layers.indexOf(view);
      this.layers.splice(i, 1);
    }
    delete this.views[id]; // remove from views hash
    view.off(undefined, undefined, this);

    view.getChildViews().forEach(function(v) {
      that.unregisterView(v);
    });
  },
  /**
   * Will return all paths to active frames
   * @param {boolean} minimise When true, minimise the returned paths
   * @returns {array} An array of strings pointing to active frames within the document
   */
  exportState: function(minimise) {
    minimise = minimise || false;
    var state = [];
    var that = this;

    this.layers.map(function(layerId) {
        return that.views[layerId].view.outerEl;
      }).sort($.comparePosition)
      .forEach(function(layerOuterEl) {
        var layer = layerOuterEl._ljView;
        if (layer.currentFrame) {
          state.push(that.views[layer.currentFrame.id()].path);
          if (true === minimise && (layer.noUrl() || layer.currentFrame.name() === layer.defaultFrame() ||
              (null === layer.defaultFrame() && null === layer.currentFrame.outerEl.previousSibling))) {
            state.pop();
          }
        } else if (true !== minimise) {
          state.push(that.views[layer.id()].path + ".!none");
        }
      });

    return state;
  },
  /**
   * Will return all paths to frames, layers and stages. Will be sorted in DOM order
   * @returns {array} An array of strings pointing to alle frames within the document
   */
  exportStructure: function() {
    var that = this;
    return Object.keys(this.views).map(function(key) {
      return that.views[key].view.outerEl;
    }).sort($.comparePosition).map(function(element) {
      return that.views[element._ljView.id()].path;
    }); // FIXME
  },
  /**
   * Will transition to a state
   *
   * @param {array} states State paths to transition to
   * @param {object} transitions Array of transition records, one per state path, or a single transition record for all paths. Can be undefined in which case a default transition is triggered
   */
  transitionTo: function(states, transitions) {
    transitions = Array.isArray(transitions) && transitions || [transitions || {}];
    var that = this;
    // build an array that contains all layer/frame combinations that need to transition including their transitions records
    var paths = states.map(function(state) {
      return that.resolvePath(state);
    });

    var reduced = [];

    paths.reduce(function(collection, layerframe, index) {
      for (var i = 0; i < layerframe.length; i++) {
        if (!layerframe[i].active || states.indexOf(layerframe[i].path) !== -1) {
          // for some reason the collection parameter is undefined the second pass ( solution use the reduced collection directly)
          reduced.push({ // ignore currently active frames
            layer: layerframe[i].layer,
            frameName: layerframe[i].frameName,
            transition: transitions[Math.min(index, transitions.length - 1)] || {}
          });
        }
      }
    }, reduced);

    paths = reduced;
    var semaphore = new Kern.Semaphore(paths.length); // semaphore is necessary to let all transition run in sync
    var groupId = ++this._transitionGroupId;
    this._transitionGroup[groupId] = paths.length;
    for (var i = 0; i < paths.length; i++) {
      paths[i].transition.semaphore = semaphore;
      paths[i].transition.groupId = groupId;
      paths[i].layer.transitionTo(paths[i].frameName, paths[i].transition); // run the transition on the corresponding layer
    }
    return paths.length > 0;
  },
  /**
   * Will transition to a state without animation
   *
   * @param {array} states State paths to transition to
   */
  showState: function(states) {
    var that = this;
    // build an array that contains all layer/frame combinations that need to transition including their transitions records
    var transitions = [];

    states.map(function(state) {
      return that.resolvePath(state);
    }).reduce(function(collection, layerframe) {
      for (var i = 0; i < layerframe.length; i++) {
        if (!layerframe[i].active) transitions.push({ // ignore currently active frames
          layer: layerframe[i].layer,
          frameName: layerframe[i].frameName
        });
      }
    }, []);

    // semaphore is necessary to let all transition run in sync
    var groupId = ++this._transitionGroupId;
    this._transitionGroup[groupId] = transitions.length;
    var transition = {
      semaphore: new Kern.Semaphore(transitions.length),
      groupId: groupId
    };

    for (var i = 0; i < transitions.length; i++) {
      transitions[i].layer.showFrame(transitions[i].frameName, transition); // switch to frame
    }
    return transitions.length > 0;
  },
  /**
   * create the path of a particular view
   *
   * @param {HTMLElement} node - the HTML node for which the layerJS path should be build
   * @param {boolean} reCalculate - if true, no lookups will be used
   * @returns {string} the path
   */
  buildPath: function(node, reCalculate) {
    if (!node) return "";

    if (!node._ljView)
      return this.buildPath(node.parentNode);

    var parentView = node._ljView.parent;

    var parentPath = (!reCalculate && parentView) ? this.views[parentView.id()].path : this.buildPath(node.parentNode);

    if (parentPath !== '')
      parentPath += '.';

    return parentPath + node._ljView.name();
  },
  /**
   * calculate all different endings of a path
   *
   * @param {string} path - the full path
   * @returns {Array} array of path endings
   */
  getTrailingPaths: function(path) {
    var paths = [path];
    while ((path = path.replace(/^[^\.]*\.?/, ''))) {
      paths.push(path);
    }
    return paths;
  },
  /**
   * Resolves the layer that will execute the transition for a given path and the frame name (could be a special name)
   *
   * @param {string} path - a path of the state
   * @param {HTMLElement} context - the HTML context where the name should be resolved (e.g. where the link was located)
   * @returns {Array} Array of layerViews and the frameNames;
   */
  resolvePath: function(path, context) {
    var i, contextpath = context && this.buildPath(context),
      segments = path.split('.'),
      frameName = segments.pop(),
      isSpecial = (frameName[0] === '!'),
      layerpath = segments.join('.'),
      candidates = (isSpecial ? (layerpath ? this.paths[layerpath] : this.layers) : this.paths[path]); // if special frame name, only search for layer

    if (!candidates || candidates.length === 0) throw "state: could not resolve path '" + path + "'";
    if (candidates.length > 1 && contextpath) { // check whether we can reduce list of candidates be resolving relative to the context path
      var reduced = [];
      while (reduced.length === 0 && contextpath) { // if we don't find any frames in context, move context path one up and try again
        for (i = 0; i < candidates.length; i++) {
          if (this.views[candidates[i]].path.startsWith(contextpath)) reduced.push(candidates[i]);
        }
        contextpath = contextpath.replace(/\.?[^\.]$/, '');
      }
      candidates = (reduced.length ? reduced : candidates); // take original candidates if context didn't contain any
    }
    var result = [];
    for (i = 0; i < candidates.length; i++) {
      var view = this.views[candidates[i]].view;
      if (isSpecial) {
        if (view.type() !== 'layer') throw "state: expected layer name in front of '" + frameName + "'";
        result.push({
          layer: view,
          frameName: frameName
        });
      } else {
        if (view.type() === 'frame') { // for frames return a bit more information which is helpful to trigger the transition
          result.push({
            layer: view.parent,
            view: view,
            frameName: frameName,
            path: this.buildPath(view.outerEl, false),
            active: (undefined !== view.parent.currentFrame && null !== view.parent.currentFrame) ? view.parent.currentFrame.name() === frameName : false
          });
        } else {
          result.push({
            view: view
          });
        }
      }
    }
    return result;
  },
  /**
   * Will return the handler for an attributesChanged event
   *
   * @param {object}  a view
   * @returns {function} function that will be called when an attributesChanged event is invoked
   */
  _attributesChangedEvent: function(view) {
    var that = this;
    return function(attributes) {
      if (attributes['lj-name'] || attributes['data-lj-name'] || attributes.id) {
        that.unregisterView(view);
        that.registerView(view);
      }
    };
  },
  /**
   * Will return a view based on the path
   * @param {string} path document who's state will be exported
   * @returns {Object} A view
   */
  getViewByPath: function(path) {
    var result;
    if (undefined !== this.paths[path]) {
      for (var i = 0; i < this.paths[path].length; i++) {
        var id = this.paths[path][i];
        if (this.views[id].path === path) {
          result = this.views[id].view;
        }
      }
    }

    return result;
  }
}, {
  /**
   * Resolves the state for a specific document
   *
   * @param {object} doc - A document where the state needs to be retrieved, if undefined the global document will be used
   * @returns {object} The current state object for the document
   */
  getState: function(doc) {
    doc = doc || document;
    return doc._ljState || new State(doc);
  }
});

layerJS.getState = State.getState;
module.exports = State;
