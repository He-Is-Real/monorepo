import { NoRoleRequired, RequiresRole, resolveRolePolicy } from './role-policy';

describe('role decorators', () => {
  class Open {
    @NoRoleRequired('a probe that reads nothing')
    probe() {
      return 1;
    }
    @RequiresRole('Admin')
    admin() {
      return 1;
    }
    plain() {
      return 1;
    }
  }
  @RequiresRole('User')
  class Personal {
    mine() {
      return 1;
    }
    @RequiresRole('Admin')
    both() {
      return 1;
    }
  }

  it('resolve one decorator on the handler or its class', () => {
    expect(resolveRolePolicy(Open.prototype.probe, Open)).toEqual({
      ok: true,
      policy: { kind: 'none', reason: 'a probe that reads nothing' },
    });
    expect(resolveRolePolicy(Open.prototype.admin, Open)).toEqual({
      ok: true,
      policy: { kind: 'requires', minimum: 'Admin' },
    });
    expect(resolveRolePolicy(Personal.prototype.mine, Personal)).toEqual({
      ok: true,
      policy: { kind: 'requires', minimum: 'User' },
    });
  });

  it('treat none, or one on each, as a misconfiguration', () => {
    expect(resolveRolePolicy(Open.prototype.plain, Open)).toEqual({
      ok: false,
      problem: 'has neither @RequiresRole nor @NoRoleRequired',
    });
    expect(resolveRolePolicy(Personal.prototype.both, Personal)).toMatchObject({
      ok: false,
    });
  });

  it('refuse unknown roles and empty reasons at decoration time', () => {
    expect(() => RequiresRole('Owner' as never)).toThrow('unknown role');
    expect(() => NoRoleRequired('short')).toThrow('real reason');
  });
});
