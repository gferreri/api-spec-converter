'use strict';

var _ = require('lodash');
var assert = require('assert');
var Inherits = require('util').inherits;
var Path = require('path');
var URI = require('urijs');
var Promise = require('bluebird');
var Xml2Js = require('xml2js');

var BaseFormat = require('../base_format.js');
var Util = require('../util.js');

var WADL = module.exports = function() {
  WADL.super_.apply(this, arguments);
  this.format = 'wadl';

  this.converters.swagger_2 =
    Promise.method(wadl => convertToSwagger(wadl.spec));

  this.converters.openapi_3 =
    Promise.method(swagger1 => this.convertTransitive(['swagger_2', 'openapi_3']));
}

Inherits(WADL, BaseFormat);

WADL.prototype.formatName = 'wadl';
WADL.prototype.supportedVersions = ['1.0'];
WADL.prototype.getFormatVersion = function () {
  return '1.0';
}

WADL.prototype.parsers = {
  'XML': data => Promise.promisify(Xml2Js.parseString)(data, {
    //HACK: we just strip namespace. Yes I know, it's ugly.
    //But handling XML namespaces is even uglier.
    tagNameProcessors: [Xml2Js.processors.stripPrefix],
    attrNameProcessors: [Xml2Js.processors.stripPrefix]
  })
};

WADL.prototype.checkFormat = function (spec) {
  return true;
}

function convertToSwagger(wadl) {
  var convertStyle = function(style) {
    switch (style) {
      case 'query':
      case 'header':
        return style;
      case 'template':
        return 'path';
      default:
        assert(false);
    }
  }
  var convertType = function(wadlType) {
    if (_.isUndefined(wadlType))
      return {};

    //HACK: we just strip namespace. Yes I know, it's ugly.
    //But handling XML namespaces is even uglier.
    var match = wadlType.match(/^(?:[^:]+:)?(.+)$/);
    assert(match, wadlType);
    var type = match[1];
    switch (type.toLowerCase()) {
      case 'boolean':
      case 'string':
      case 'integer':
        return {type: type};
      case 'double':
      case 'decimal':
        return {type: 'number'};
      case 'int':
        return {type: 'integer', format: 'int32'};
      case 'long':
        return {type: 'integer', format: 'int64'};
      case 'positiveInteger':
        return {type: 'integer', minimum: 1};
      case 'anyURI':
      case 'date':
      case 'time':
      case 'date-time':
        //TODO: add 'format' where possible
        return {type: 'string'};
      default:
        //HACK: convert unknown types into 'string' these works for everything,
        //except body and responces but we don't support them yet.
        return {type: 'string'};
        //TODO: add warning
        //assert(false, 'Unsupported type: ' + wadlType);
    }
  }

  var convertDoc = function (doc) {
    if (_.isUndefined(doc))
      return {};

    assert(_.isArray(doc));
    var result = {};
    _.each(doc, function (docElement) {
      if (_.isPlainObject(docElement)) {
        if (docElement.description && Array.isArray(docElement.description)) {
          docElement = docElement.description[0]
        } else if (docElement.summary && Array.isArray(docElement.summary)) {
          docElement = docElement.summary[0]
        }
        //Handle Apigee extension
        var externalUrl = docElement.$ && docElement.$['url'];
        if (externalUrl)
          result.externalDocs = {url: externalUrl};
        docElement = docElement._;
        if (!_.isString(docElement))
          return;
      }

      assert(_.isString(docElement));
      docElement = docElement.trim();
      if (result.description)
        result.description += '\n' + docElement;
      else
        result.description = docElement;
    });
    return result;
  }

  var convertDefault = function (wadlDefault, type) {
    if (type === 'string')
      return wadlDefault;
    return JSON.parse(wadlDefault);
  }

  var convertParameter = function(wadlParam) {
    var loc = convertStyle(wadlParam.$.style);
    var ret = {
      name: wadlParam.$.name,
      required: loc === 'path' ? true : JSON.parse(wadlParam.$.required || 'false'),
      in: loc,
      type: 'string', //default type
    };
    _.assign(ret, convertType(wadlParam.$.type));

    var wadlDefault = wadlParam.$.default;
    if (!_.isUndefined(wadlDefault))
      ret.default = convertDefault(wadlDefault, ret.type);

    var doc = convertDoc(wadlParam.doc);
    //FIXME:
    delete doc.externalDocs;
    _.extend(ret,doc);

    if (wadlParam.option) {
      ret.enum = wadlParam.option.map(function(opt) {
        return opt.$.value;
      })
    }
    return ret;
  }

  function unwrapArray(array) {
    if (_.isUndefined(array))
      return;

    assert(_.isArray(array));
    assert(_.size(array) === 1);
    return array[0];
  }

  function convertTemplateToParam(template) {
    var mapProperties = function (template) {
      if (typeof template === "object") {

        return _.mapValues(template, function (o) { 
          if (!Array.isArray(o)) {
            return { 
              type: "string",
              description: o
            }
          } else {
            // console.log(o)
            return {
              type: "array",
              items: mapProperties(o[0])
            }
          }
        })
      } else {
        return {
          type: "string",
          description: template
        }
      }
    }
    var param = { 
      in: "body",
      name: "JSON document",
    }
    param.schema = {
      type: "object",
      properties: mapProperties(template)
    }
    return param
  }

  function convertMethod(wadlMethod) {
    var method = {
      operationId: wadlMethod.$.id,
      responses: {
        //FIXME: take responces from WADL file
        200: {
          description: 'Successful Response'
        }
      }
    };
    
    var wadlRequest = unwrapArray(wadlMethod.request);
    if (wadlRequest)
    method.parameters = _.uniqBy(_.map(wadlRequest.param, convertParameter),function(e){
      return e.name + e.in });
      if (_.isEmpty(method.parameters)) {
        if (wadlMethod.doc) {
          var unwrapped = unwrapArray(wadlMethod.doc)
          if (unwrapped.template) {
            // If the wadl request has a "template" defined and no other parameters,
            // then we will create a dummy "object" parameter to accept the input document.
            var template = JSON.parse(unwrapArray(unwrapped.template)._)
            var param = convertTemplateToParam(template)
            let split = _.split(_.startCase(method.operationId), ' ')
            split.shift()
            const paramName = split.join('')
            method.parameters.push({
              in: "body",
              name: paramName,
              required: true,
              description: _.unescape(JSON.stringify(template, null, 2)),
              schema: {
                type: "object"
              }
            })
          }
        }
      }

    _.extend(method, convertDoc(wadlMethod.doc));

    return method;
  }

  // Jersey use very strange extension to WADL. See:
  // https://docs.oracle.com/cd/E19776-01/820-4867/6nga7f5nc/index.html
  // They add {<name>: <regex>} template parameters which should be converted
  // to {<name>}. Tricky part is find end of regexp.
  function convertPath(path) {
    function indexOf(ch, startPosition) {
      var pos = path.indexOf(ch, startPosition);
      if (pos === -1)
        return pos;

      var slashNumber = 0;
      while (path.charAt(pos - 1 - slashNumber) === '\\')
        ++slashNumber;

      if (slashNumber % 2 === 0)
        return pos;

      //Skip escaped symbols
      return indexOf(ch, pos + 1);
    }

    var match;

    //RegEx should be inside loop to reset iteration
    while (match = /{([^}:]+):/g.exec(path)) {
      var deleteBegin = match.index + match[0].length - 1;
      var deleteEnd = deleteBegin;

      var unmatched = 1;
      while (unmatched !== 0) {

        var open = indexOf('{', deleteEnd + 1);
        var close = indexOf('}', deleteEnd + 1);

        if (close === -1)
          throw Error('Unmatched curly brackets in path: ' + path);

        if (open !==  -1 && open < close) {
          ++unmatched;
          deleteEnd = open;
        }
        else {
          --unmatched;
          deleteEnd = close;
        }
      }

      //For future use: regex itself is
      //path.substring(deleteBegin + 1, deleteEnd)

      path = path.slice(0, deleteBegin) + path.slice(deleteEnd);
    }

    return path;
  }

  function convertResource(wadlResource) {
    var resourcePath = Util.joinPath('/', convertPath(wadlResource.$.path));
    var paths = {};

    //Not supported
    assert(!_.has(wadlResource, 'resource_type'));
    assert(!_.has(wadlResource, 'resource_type'));

    var resource = {};
    var commonParameters = _.uniqBy(_.map(wadlResource.param, convertParameter),function(e){
    return e.name + e.in });

    _.each(wadlResource.method, function(wadlMethod) {
      var httpMethod = wadlMethod.$.name.toLowerCase();
      resource[httpMethod] = convertMethod(wadlMethod);
    });

    if (!_.isEmpty(resource)) {
      resource.parameters = commonParameters;
      paths[resourcePath] = resource;
    }

    _.each(wadlResource.resource, function (wadlSubResource) {
      var subPaths = convertResource(wadlSubResource);
      subPaths = _.mapKeys(subPaths, function (subPath, path) {
        subPath.parameters = _.uniqBy(commonParameters.concat(subPath.parameters),function(e){
        return e.name + e.id });
        return Util.joinPath(resourcePath, convertPath(path));
      });
      mergePaths(paths, subPaths);
    });

    return paths;
  }

  function mergePaths(paths, pathsToAdd) {
    _.each(pathsToAdd, function (resource, path) {
      var existingResource = paths[path];
      if (!_.isUndefined(existingResource)) {
        assert(_.isEqual(existingResource.parameters, resource.parameters));
        _.extend(existingResource, resource);
      }
      else
        paths[path] = resource;
    });
  }

  var root = unwrapArray(wadl.application.resources);
  var title = wadl.application.doc && wadl.application.doc[1] && wadl.application.doc[1].$ ?
    wadl.application.doc[1].$.title : "";

  var baseUrl = URI(root.$.base);
  var swagger = {
    swagger: '2.0',
    info: {
      title: title,
      version: ""
    },
    host:  baseUrl.host() || undefined,
    basePath: baseUrl.pathname() || undefined,
    schemes: baseUrl.protocol() ? [baseUrl.protocol()] : undefined,
    paths: {}
  };

  _.each(root.resource, function(wadlResource) {
    mergePaths(swagger.paths, convertResource(wadlResource));
  });

  return swagger;
}

