#!/usr/bin/env node

import 'source-map-support/register';
import cdk = require('@aws-cdk/core');
import {
  MeshDemoStack
} from '../lib/mesh-demo-stack';


const mesh = new cdk.App();
new MeshDemoStack(mesh, 'mesh', {
  "stackName": "mesh",
  "env": {
    "region": "eu-west-1",
    "account": "192011874229"
  }
});