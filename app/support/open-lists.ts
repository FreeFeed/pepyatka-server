import _ from 'lodash';

export type ListLike<T> = List<T> | T[] | { items: T[]; inclusive: boolean };

/**
 * List represents a possible open list of items. It can model two situation:
 * 1. All these items (when 'inclusive' is true);
 * 2. All items EXCEPT of these (when 'inclusive' is false).
 */
export class List<T> {
  constructor(
    public items: T[] = [],
    public inclusive: boolean = true,
  ) {}

  isEmpty() {
    return this.inclusive && this.items.length === 0;
  }

  isEverything() {
    return !this.inclusive && this.items.length === 0;
  }

  includes(item: T) {
    return this.inclusive === this.items.includes(item);
  }

  /**
   * Return List made of items if arg is an array, arg themself if it is a List instance,
   * or re-created List if arg has shape of List. The returning object is always a List instance.
   */
  static from<X>(list: ListLike<X>): List<X> {
    if (list instanceof List) {
      return list;
    } else if (Array.isArray(list)) {
      return new List(list);
    } else if (
      typeof list === 'object' &&
      Array.isArray(list.items) &&
      typeof list.inclusive === 'boolean'
    ) {
      return new List(list.items, list.inclusive);
    }

    return List.empty();
  }

  static empty<X = any>() {
    return new List<X>();
  }

  static everything<X = any>() {
    return new List<X>([], false);
  }

  /**
   * Return the inversion of list i.e. List.difference(List.everything(), list)
   */
  static inverse<X>(list: ListLike<X>) {
    list = List.from(list);
    return new List(list.items, !list.inclusive);
  }

  static difference<X>(list1: ListLike<X>, list2: ListLike<X>) {
    list1 = List.from(list1);
    list2 = List.from(list2);

    if (list1.inclusive && list2.inclusive) {
      // [1,2] - [2,3,4] = [1]
      return new List(_.difference(list1.items, list2.items));
    } else if (list1.inclusive && !list2.inclusive) {
      // [1,2] - ^[2,3,4] = [2]
      return new List(_.intersection(list1.items, list2.items));
    } else if (!list1.inclusive && list2.inclusive) {
      // ^[1,2] - [2,3,4] = ^[1,2,3,4]
      return new List(_.union(list1.items, list2.items), false);
    } else if (!list1.inclusive && !list2.inclusive) {
      // ^[1,2] - ^[2,3,4] = [3,4]
      return new List(_.difference(list2.items, list1.items));
    }

    // unreachable
    return new List<never>();
  }

  static union<X>(list1: ListLike<X>, list2: ListLike<X>) {
    list1 = List.from(list1);
    list2 = List.from(list2);

    if (list1.inclusive && list2.inclusive) {
      // [1,2] + [2,3,4] = [1,2,3,4]
      return new List(_.union(list1.items, list2.items));
    } else if (list1.inclusive && !list2.inclusive) {
      // [1,2] + ^[2,3,4] = ^[3,4]
      return new List(_.difference(list2.items, list1.items), false);
    } else if (!list1.inclusive && list2.inclusive) {
      // ^[1,2] + [2,3,4] = ^[1]
      return new List(_.difference(list1.items, list2.items), false);
    } else if (!list1.inclusive && !list2.inclusive) {
      // ^[1,2] + ^[2,3,4] = ^[2]
      return new List(_.intersection(list2.items, list1.items), false);
    }

    // unreachable
    return new List<X>();
  }

  static intersection<X>(list1: ListLike<X>, list2: ListLike<X>) {
    list1 = List.from(list1);
    list2 = List.from(list2);

    if (list1.inclusive && list2.inclusive) {
      // [1,2] & [2,3,4] = [2]
      return new List(_.intersection(list1.items, list2.items));
    } else if (list1.inclusive && !list2.inclusive) {
      // [1,2] & ^[2,3,4] = [1]
      return new List(_.difference(list1.items, list2.items));
    } else if (!list1.inclusive && list2.inclusive) {
      // ^[1,2] & [2,3,4] = [3,4]
      return new List(_.difference(list2.items, list1.items));
    } else if (!list1.inclusive && !list2.inclusive) {
      // ^[1,2] & ^[2,3,4] = ^[1,2,3,4]
      return new List(_.union(list1.items, list2.items), false);
    }

    // unreachable
    return new List();
  }

  static equal(list1: any, list2: any) {
    list1 = List.from(list1);
    list2 = List.from(list2);

    return List.difference(list1, list2).isEmpty() && List.difference(list2, list1).isEmpty();
  }
}
